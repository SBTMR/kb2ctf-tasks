"""Чтение локальной базы OSM и измерение расстояний."""

from collections import Counter
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
import sqlite3
import time

from pyproj import CRS, Transformer
import shapely


DEFAULT_DATABASE = Path(__file__).resolve().parent / "russia.gpkg"
LAYER_ORDER = ("points", "multipolygons", "lines", "multilinestrings", "other_relations")
TAG_FIELDS = ("other_tags", "all_tags")
SERVICE_FIELDS = {
    "fid", "geom", "geometry", "osm_id", "osm_way_id", "osm_type",
    "other_tags", "all_tags",
}
TAG_ALIASES = {
    "building_levels": "building:levels",
    "building_colour": "building:colour",
    "roof_colour": "roof:colour",
}
HSTORE_PAIR = re.compile(
    r'("(?:[^"\\]|\\.)*")\s*=>\s*("(?:[^"\\]|\\.)*"|NULL)',
    re.DOTALL,
)


@dataclass
class MapObject:
    source_key: str
    osm_id: str
    geometry: object
    tags: dict


def unquote_hstore(text):
    # В HSTORE обратный слеш экранирует кавычки и сам себя.
    quoted_text = text[1:-1]
    return re.sub(r'\\(["\\])', lambda match: match.group(1), quoted_text)


def read_tag_field(text):
    if text.lstrip().startswith("{"):
        try:
            tags = json.loads(text, strict=False)
            if isinstance(tags, dict):
                return tags
        except (ValueError, TypeError):
            pass

    tags = {}
    for key, value in HSTORE_PAIR.findall(text):
        if value != "NULL":
            tags[unquote_hstore(key)] = unquote_hstore(value)
    return tags


def read_tags(row):
    tags = {}
    for field_name in TAG_FIELDS:
        text = row.get(field_name) or ""
        if not isinstance(text, str):
            continue
        for key, value in read_tag_field(text).items():
            if value is not None:
                tags[str(key)] = str(value)

    for column_name, value in row.items():
        if column_name in SERVICE_FIELDS or value in (None, ""):
            continue
        tag_name = TAG_ALIASES.get(column_name, column_name)
        tags.setdefault(tag_name, str(value))
    return tags


def read_geometry(data):
    if not data:
        return None
    data = bytes(data)

    if data[:2] == b"GP":
        # После заголовка GeoPackage могут идти границы объекта, затем WKB.
        envelope_type = (data[3] >> 1) & 7
        envelope_values = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}
        header_size = 8 + envelope_values[envelope_type] * 8
        data = data[header_size:]

    geometry = shapely.from_wkb(data)
    if geometry.is_empty:
        return None
    if not geometry.is_valid:
        geometry = shapely.make_valid(geometry)
    return geometry


def read_object(layer_name, database_row):
    row = dict(database_row)
    geometry = read_geometry(row.get("geom"))
    if geometry is None:
        return None

    object_number = row.get("osm_id")
    object_type = "way"
    if layer_name == "points":
        object_type = "node"
    elif layer_name == "multipolygons":
        if row.get("osm_way_id"):
            object_number = row["osm_way_id"]
        else:
            object_type = "relation"
    elif layer_name in {"multilinestrings", "other_relations"}:
        object_type = "relation"

    return MapObject(
        source_key=f"{layer_name}:{row['fid']}",
        osm_id=f"{object_type}/{object_number}",
        geometry=geometry,
        tags=read_tags(row),
    )


class Progress:
    def __init__(self):
        self.counts = Counter()
        self.next_message = time.monotonic()

    def report(self, force=False):
        if force or time.monotonic() >= self.next_message:
            values = []
            for name, count in sorted(self.counts.items()):
                values.append(f"{name}={count}")
            message = ", ".join(values) or "читаю базу"
            print(f"Прогресс: {message}", flush=True)
            self.next_message = time.monotonic() + 20
        return 0


class OsmDatabase:
    def __init__(self, path, progress):
        self.connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA query_only=ON")
        self.connection.execute("PRAGMA cache_size=-32768")
        self.connection.execute("PRAGMA temp_store=MEMORY")
        self.connection.set_progress_handler(progress.report, 100000)
        self.layers = self.read_layers()

    def read_layers(self):
        metadata = {}
        query = "SELECT table_name,column_name,srs_id FROM gpkg_geometry_columns"
        for table_name, geometry_column, crs in self.connection.execute(query):
            metadata[table_name] = (geometry_column, crs)

        layers = {}
        primary_layers = [name for name in metadata if name in {"points", "multipolygons"}]
        extra_layers = [name for name in metadata if name in LAYER_ORDER and name not in primary_layers]
        for layer_name in primary_layers + extra_layers:
            geometry_column, crs = metadata[layer_name]
            if geometry_column != "geom" or crs != 4326:
                if layer_name in {"points", "multipolygons"}:
                    raise ValueError(f"Слой {layer_name}: ожидаются geom и EPSG:4326")
                continue

            columns = set()
            for row in self.connection.execute(f'PRAGMA table_info("{layer_name}")'):
                columns.add(row[1])

            if layer_name in {"points", "multipolygons"}:
                if "fid" not in columns or "osm_id" not in columns:
                    raise ValueError(f"Неподдерживаемая схема {layer_name}")
                index_name = f"rtree_{layer_name}_geom"
                index_query = "SELECT 1 FROM sqlite_master WHERE name=?"
                if not self.connection.execute(index_query, (index_name,)).fetchone():
                    raise ValueError(f"Нет пространственного индекса {index_name}")
            layers[layer_name] = columns

        if "multipolygons" not in layers:
            raise ValueError("Нужен слой контуров зданий multipolygons")
        return layers

    def close(self):
        self.connection.close()

    def fountains(self):
        for layer_name, columns in self.layers.items():
            conditions = []
            if "amenity" in columns:
                conditions.append("t.amenity='fountain'")
            for tag_field in TAG_FIELDS:
                if tag_field in columns:
                    conditions.append(f"t.{tag_field} LIKE '%fountain%'")
            if not conditions:
                continue

            print(f"Ищу фонтаны: {layer_name}", flush=True)
            tag_condition = " OR ".join(conditions)
            query = f'SELECT t.* FROM "{layer_name}" t WHERE ({tag_condition})'
            for row in self.connection.execute(query):
                if read_tags(dict(row)).get("amenity") != "fountain":
                    continue
                fountain = read_object(layer_name, row)
                if fountain is None:
                    continue
                yield fountain

    def nearby_condition(self, layer_name):
        columns = self.layers[layer_name]
        conditions = []
        if "building" in columns:
            conditions.append("COALESCE(t.building,'') NOT IN ('','no')")
        if "amenity" in columns:
            conditions.append("t.amenity IN ('fountain','place_of_worship')")
        if "man_made" in columns:
            conditions.append("t.man_made='fountain'")
        for tag_field in ("all_tags", "other_tags"):
            if tag_field in columns:
                for text in ("building", "fountain", "place_of_worship"):
                    conditions.append(f"t.{tag_field} LIKE '%{text}%'")
        return "(" + " OR ".join(conditions or ["0"]) + ")"

    def nearby_objects(self, center, radius):
        west, south, east, north = center.geometry.bounds
        latitude_padding = (radius + 2) / 110000
        edge_latitude = max(abs(south), abs(north)) + latitude_padding
        edge_latitude = min(89.9, edge_latitude)
        longitude_scale = max(0.01, math.cos(math.radians(edge_latitude)))
        longitude_padding = (radius + 2) / (110000 * longitude_scale)

        south = max(-90, south - latitude_padding)
        north = min(90, north + latitude_padding)
        west -= longitude_padding
        east += longitude_padding

        longitude_ranges = [(west, east)]
        if west < -180:
            longitude_ranges = [(-180, east), (west + 360, 180)]
        elif east > 180:
            longitude_ranges = [(west, 180), (-180, east - 360)]

        seen_objects = set()
        for layer_name in self.layers:
            condition = self.nearby_condition(layer_name)
            for left, right in longitude_ranges:
                query = f"""
                    SELECT t.* FROM rtree_{layer_name}_geom r
                    JOIN "{layer_name}" t ON t.fid = r.id
                    WHERE r.minx <= ? AND r.maxx >= ?
                      AND r.miny <= ? AND r.maxy >= ? AND {condition}
                """
                parameters = (right, left, north, south)
                for row in self.connection.execute(query, parameters):
                    source_key = f"{layer_name}:{row['fid']}"
                    if source_key in seen_objects:
                        continue
                    seen_objects.add(source_key)
                    tags = read_tags(dict(row))
                    if not useful_neighbor(tags):
                        continue
                    neighbor = read_object(layer_name, row)
                    if neighbor is not None:
                        yield neighbor


def useful_neighbor(tags):
    def value(name):
        return str(tags.get(name, "")).strip().lower()

    building_type = value("building")
    if building_type not in {"", "no", "demolished", "ruins", "construction"}:
        return True
    if building_type in {"church", "cathedral", "chapel"}:
        return True
    if value("amenity") == "fountain" or value("man_made") == "fountain":
        return True
    if value("amenity") == "place_of_worship":
        if value("religion") == "christian":
            return True
        return value("denomination") in {
            "orthodox", "russian_orthodox", "catholic", "protestant", "lutheran",
        }
    return False


def geometry_outline(geometry):
    if geometry.geom_type in {"Polygon", "MultiPolygon"}:
        return geometry.boundary
    return geometry


class LocalCoordinates:
    def __init__(self, center):
        point = center.geometry.representative_point()
        projection = CRS.from_proj4(
            f"+proj=aeqd +lat_0={point.y} +lon_0={point.x} +datum=WGS84 +units=m"
        )
        self.to_meters = Transformer.from_crs(4326, projection, always_xy=True).transform
        self.to_wgs84 = Transformer.from_crs(projection, 4326, always_xy=True).transform
        self.geometries = {}

    def geometry(self, map_object):
        if map_object.source_key not in self.geometries:
            self.geometries[map_object.source_key] = shapely.transform(
                map_object.geometry, self.to_meters, interleaved=False,
            )
        return self.geometries[map_object.source_key]

    def distance(self, first_object, second_object):
        first_outline = geometry_outline(self.geometry(first_object))
        second_outline = geometry_outline(self.geometry(second_object))
        return float(first_outline.distance(second_outline))


def within_radius(distance, radius):
    return math.isfinite(distance) and distance <= radius + 1e-6


class GeoJsonWriter:
    def __init__(self, path):
        self.file = path.open("w", encoding="utf-8")
        self.file.write('{"type":"FeatureCollection","features":[\n')
        self.count = 0

    def add(self, geometry, properties):
        if self.count:
            self.file.write(",\n")
        feature = {"type": "Feature", "geometry": geometry, "properties": properties}
        self.file.write(json.dumps(feature, ensure_ascii=False, allow_nan=False))
        self.count += 1

    def close(self):
        self.file.write("\n]}\n")
        self.file.close()
