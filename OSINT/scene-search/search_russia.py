"""Поиск синей крыши, жилого дома, церкви и фонтана в локальной базе OSM."""

import argparse
from collections import OrderedDict
import csv
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import shapely
from shapely.geometry import mapping
from shapely.ops import nearest_points

from osm_database import (
    DEFAULT_DATABASE,
    GeoJsonWriter,
    LocalCoordinates,
    MapObject,
    OsmDatabase,
    Progress,
    geometry_outline,
    within_radius,
)


HOUSE_TO_ROOF_METERS = 50
HOUSE_TO_CHURCH_METERS = 200
CHURCH_TO_FOUNTAIN_METERS = 30
CACHE_SIZE = 512
GIB = 1024 ** 3
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "results"

GEOJSON_FILES = (
    "complete", "partial", "conflicts", "objects", "footprints", "links",
)
RESULT_FILES = [f"{name}.geojson" for name in GEOJSON_FILES]
RESULT_FILES.extend(["candidates.csv", "summary.json"])
CSV_COLUMNS = [
    "candidate_id", "status", "score", "latitude", "longitude",
    "blue_id", "house_id", "church_id", "fountain_id",
    "roof_colour", "house_levels", "blue_is_house", "blue_address",
    "house_address", "house_start_date", "church_name",
    "house_blue_m", "house_church_m", "church_fountain_m",
]


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    arguments = read_arguments()
    if arguments._worker:
        run_search(arguments)
    else:
        run_with_disk_monitor(arguments)


def read_arguments():
    parser = argparse.ArgumentParser(
        description="Синяя крыша — дом 4–5 этажей ≤50м — церковь ≤200м — фонтан ≤30м; вся Россия"
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-work-gb", type=float, default=2)
    parser.add_argument("--min-free-gb", type=float, default=10)
    parser.add_argument("--_worker", type=Path, help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    arguments.source = arguments.source.resolve()
    arguments.output = arguments.output.resolve()

    if not arguments.source.is_file():
        raise ValueError(f"Не найден источник: {arguments.source}")
    for value in (arguments.max_work_gb, arguments.min_free_gb):
        if not math.isfinite(value) or value <= 0:
            raise ValueError("Пороги диска должны быть положительными конечными числами")
    return arguments


def run_with_disk_monitor(arguments):
    arguments.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".roof_run_", dir=arguments.output) as folder:
        temporary_directory = Path(folder).resolve()
        free_space = shutil.disk_usage(arguments.output).free
        if free_space < arguments.min_free_gb * GIB:
            raise RuntimeError("Недостаточно свободного места для указанного запаса")

        process = start_search_process(arguments, temporary_directory)
        stop_reason = None
        try:
            while process.poll() is None:
                stop_reason = disk_stop_reason(arguments, temporary_directory)
                if stop_reason:
                    break
                time.sleep(0.5)
        finally:
            # Сначала прекращаем запись файлов, затем удаляем временную папку.
            stop_process(process)

        if stop_reason:
            raise RuntimeError(stop_reason + "; временные файлы удаляются")
        if process.returncode:
            raise RuntimeError(
                f"Обработчик завершился с кодом {process.returncode}; прежние результаты сохранены"
            )
        if disk_stop_reason(arguments, temporary_directory):
            raise RuntimeError("Порог диска превышен перед сохранением результатов")

        for filename in RESULT_FILES:
            if not (temporary_directory / filename).is_file():
                raise RuntimeError("Не создан полный набор результатов")
        for filename in RESULT_FILES:
            os.replace(temporary_directory / filename, arguments.output / filename)
    print(f"Результаты сохранены: {arguments.output}", flush=True)


def start_search_process(arguments, temporary_directory):
    command = [
        sys.executable, "-u", str(Path(__file__).resolve()),
        "--source", str(arguments.source),
        "--_worker", str(temporary_directory),
    ]
    environment = os.environ.copy()
    for variable in ("TEMP", "TMP", "TMPDIR"):
        environment[variable] = str(temporary_directory)
    environment["PYTHONIOENCODING"] = "utf-8"

    process_flags = 0
    if os.name == "nt":
        process_flags = subprocess.CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(command, env=environment, creationflags=process_flags)


def disk_stop_reason(arguments, temporary_directory):
    if directory_size(temporary_directory) > arguments.max_work_gb * GIB:
        return "Превышен порог рабочих файлов"
    if shutil.disk_usage(arguments.output).free < arguments.min_free_gb * GIB:
        return "Свободного места меньше заданного запаса"
    return None


def directory_size(directory):
    total_size = 0
    for folder, _, filenames in os.walk(directory, followlinks=False):
        for filename in filenames:
            try:
                total_size += (Path(folder) / filename).stat().st_size
            except FileNotFoundError:
                pass
    return total_size


def stop_process(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run_search(arguments):
    output_directory = arguments._worker
    output_directory.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(output_directory)
    progress = Progress()
    database = OsmDatabase(arguments.source, progress)

    try:
        print("Область поиска: вся локальная база России", flush=True)
        found_matches, matched_objects = find_matches(database, progress)
    finally:
        database.close()

    matches = sorted(found_matches.values(), key=match_sort_order)
    write_candidates(output_directory, matches)
    write_map_files(output_directory, matches, matched_objects)
    summary = make_summary(arguments, matches, matched_objects, progress)
    summary_text = json.dumps(summary, ensure_ascii=False, indent=2)
    (output_directory / "summary.json").write_text(summary_text, encoding="utf-8")

    print(summary_text, flush=True)
    for match in matches[:20]:
        print(json.dumps(match.record(), ensure_ascii=False), flush=True)
    print(f"OUTPUT: {output_directory}", flush=True)


def find_matches(database, progress):
    houses_by_church = NearbyCache()
    roofs_by_house = NearbyCache()
    matches = {}
    matched_objects = {}

    for fountain in database.fountains():
        progress.counts["fountains_in_region"] += 1
        coordinates = None

        for church in database.nearby_objects(fountain, CHURCH_TO_FOUNTAIN_METERS):
            if not is_church(church.tags):
                continue
            if coordinates is None:
                coordinates = LocalCoordinates(fountain)
            church_to_fountain = coordinates.distance(church, fountain)
            if not within_radius(church_to_fountain, CHURCH_TO_FOUNTAIN_METERS):
                continue

            progress.counts["church_fountain_edges"] += 1
            if church.source_key not in houses_by_church:
                nearby_houses = []
                for house in database.nearby_objects(church, HOUSE_TO_CHURCH_METERS):
                    if is_residential_house(house.tags):
                        nearby_houses.append(house)
                houses_by_church.save(church.source_key, nearby_houses)

            for house in houses_by_church[church.source_key]:
                house_to_church = coordinates.distance(house, church)
                if not within_radius(house_to_church, HOUSE_TO_CHURCH_METERS):
                    continue

                if house.source_key not in roofs_by_house:
                    nearby_roofs = []
                    for building in database.nearby_objects(house, HOUSE_TO_ROOF_METERS):
                        if has_blue_roof(building.tags):
                            nearby_roofs.append(building)
                    roofs_by_house.save(house.source_key, nearby_roofs)

                for blue_building in roofs_by_house[house.source_key]:
                    house_to_roof = coordinates.distance(house, blue_building)
                    if not within_radius(house_to_roof, HOUSE_TO_ROOF_METERS):
                        continue

                    # В исходном запросе дом с синей крышей может выполнять обе роли.
                    match = SceneMatch(
                        blue_building, house, church, fountain,
                        house_to_roof, house_to_church, church_to_fountain,
                    )
                    matches[match.key()] = match
                    for role, map_object in match.objects_by_role():
                        matched_objects[(map_object.source_key, role)] = map_object
                    progress.counts["combinations"] = len(matches)
        progress.report()

    return matches, matched_objects


def is_church(tags):
    if tags.get("building") in {"church", "cathedral", "chapel"}:
        return True
    return (
        tags.get("amenity") == "place_of_worship"
        and tags.get("religion") == "christian"
    )


def is_residential_house(tags):
    building_type = tags.get("building")
    floor_count = tags.get("building:levels")
    return building_type in {"apartments", "residential"} and floor_count in {"4", "5"}


def has_blue_roof(tags):
    if "building" not in tags:
        return False
    roof_colour = tags.get("roof:colour", "")
    return re.search("blue", roof_colour, re.IGNORECASE) is not None


class NearbyCache(OrderedDict):
    def save(self, key, objects):
        self[key] = objects
        self.move_to_end(key)
        while len(self) > CACHE_SIZE:
            self.popitem(last=False)


@dataclass
class SceneMatch:
    blue_building: MapObject
    house: MapObject
    church: MapObject
    fountain: MapObject
    house_to_roof: float
    house_to_church: float
    church_to_fountain: float

    def objects_by_role(self):
        return (
            ("blue", self.blue_building),
            ("house", self.house),
            ("church", self.church),
            ("fountain", self.fountain),
        )

    def key(self):
        return tuple(map_object.source_key for _, map_object in self.objects_by_role())

    def candidate_id(self):
        text = "|".join(self.key())
        return hashlib.sha1(text.encode()).hexdigest()[:16]

    def score(self):
        return 1000 - self.house_to_roof / 100 - self.house_to_church / 10000

    def record(self):
        point = self.blue_building.geometry.representative_point()
        return {
            "candidate_id": self.candidate_id(),
            "status": "complete_spatial",
            "score": self.score(),
            "longitude": point.x,
            "latitude": point.y,
            "blue_id": self.blue_building.osm_id,
            "house_id": self.house.osm_id,
            "church_id": self.church.osm_id,
            "fountain_id": self.fountain.osm_id,
            "roof_colour": self.blue_building.tags.get("roof:colour"),
            "house_levels": self.house.tags.get("building:levels"),
            "blue_is_house": self.blue_building.osm_id == self.house.osm_id,
            "blue_address": object_address(self.blue_building),
            "house_address": object_address(self.house),
            "house_start_date": self.house.tags.get("start_date", ""),
            "church_name": self.church.tags.get("name", ""),
            "house_blue_m": self.house_to_roof,
            "house_church_m": self.house_to_church,
            "church_fountain_m": self.church_to_fountain,
        }


def object_address(map_object):
    address_parts = []
    for tag_name in ("addr:city", "addr:street", "addr:housenumber"):
        value = map_object.tags.get(tag_name)
        if value:
            address_parts.append(value)
    return ", ".join(address_parts)


def match_sort_order(match):
    return -match.score(), match.candidate_id()


def write_candidates(output_directory, matches):
    path = output_directory / "candidates.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as output_file:
        writer = csv.DictWriter(output_file, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for match in matches:
            writer.writerow(match.record())


def write_map_files(output_directory, matches, matched_objects):
    writers = {}
    try:
        for name in GEOJSON_FILES:
            writers[name] = GeoJsonWriter(output_directory / f"{name}.geojson")

        for (_, role), map_object in matched_objects.items():
            properties = object_properties(map_object, role)
            point = map_object.geometry.representative_point()
            writers["objects"].add(mapping(point), properties)
            if map_object.geometry.geom_type in {"Polygon", "MultiPolygon"}:
                writers["footprints"].add(mapping(map_object.geometry), properties)

        for match in matches:
            record = match.record()
            point = {
                "type": "Point",
                "coordinates": [record["longitude"], record["latitude"]],
            }
            writers["complete"].add(point, record)
            write_measurement_lines(writers["links"], match)
    finally:
        for writer in writers.values():
            writer.close()


def object_properties(map_object, role):
    return {
        "source_key": map_object.source_key,
        "role": role,
        "osm_id": map_object.osm_id,
        "name": map_object.tags.get("name", ""),
        "roof_colour": map_object.tags.get("roof:colour", ""),
        "levels": map_object.tags.get("building:levels", ""),
        "address": object_address(map_object),
        "tags_json": json.dumps(map_object.tags, ensure_ascii=False),
    }


def write_measurement_lines(writer, match):
    coordinates = LocalCoordinates(match.blue_building)
    measurements = (
        (match.house, match.blue_building, "house_blue_m", match.house_to_roof, HOUSE_TO_ROOF_METERS),
        (match.house, match.church, "house_church_m", match.house_to_church, HOUSE_TO_CHURCH_METERS),
        (
            match.church, match.fountain, "church_fountain_m",
            match.church_to_fountain, CHURCH_TO_FOUNTAIN_METERS,
        ),
    )
    for first_object, second_object, field_name, distance, limit in measurements:
        first_outline = geometry_outline(coordinates.geometry(first_object))
        second_outline = geometry_outline(coordinates.geometry(second_object))
        first_point, second_point = nearest_points(first_outline, second_outline)
        line_in_meters = shapely.LineString([first_point, second_point])
        line = shapely.transform(line_in_meters, coordinates.to_wgs84, interleaved=False)
        properties = {
            "candidate_id": match.candidate_id(),
            "edge": field_name,
            "distance_m": distance,
            "threshold_m": limit,
            "passes": True,
        }
        writer.add(mapping(line), properties)


def make_summary(arguments, matches, matched_objects, progress):
    source_info = arguments.source.stat()
    object_counts = {}
    for role in ("blue", "house", "church", "fountain"):
        object_keys = set()
        for source_key, object_role in matched_objects:
            if object_role == role:
                object_keys.add(source_key)
        object_counts[role] = len(object_keys)

    same_building_count = 0
    for match in matches:
        if match.blue_building.osm_id == match.house.osm_id:
            same_building_count += 1

    return {
        "finished_utc": datetime.now(timezone.utc).isoformat(),
        "source": str(arguments.source),
        "source_bytes": source_info.st_size,
        "source_mtime_ns": source_info.st_mtime_ns,
        "region": "Вся существующая локальная выгрузка России, без рамки",
        "counts": dict(progress.counts),
        "combination_count": len(matches),
        "same_building_house_blue_count": same_building_count,
        "unique_objects_by_role": object_counts,
        "criteria": (
            "building + roof:colour regex blue,i; apartments/residential with levels 4/5 <=50m; "
            "church <=200m from HOUSE; amenity=fountain <=30m from church"
        ),
        "method": (
            "Local indexed OSM import, metric AEQD minimum node/segment trace distances; "
            "not a live Overpass response; no extra facade or blue/church/fountain restrictions"
        ),
        "import_provenance": "Existing local import; not verified against current live OSM.",
        "role_overlap": (
            "The original nwr query permits one building to fill both blue and house roles. "
            "These combinations are retained and flagged blue_is_house."
        ),
        "no_top_n_limit": True,
    }


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Остановлено. Временные файлы текущего запуска очищены.", file=sys.stderr)
        sys.exit(130)
    except (ValueError, RuntimeError) as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        sys.exit(1)
