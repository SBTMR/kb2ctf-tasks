FROM postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
COPY db/init.sh /docker-entrypoint-initdb.d/10-lab.sh
COPY db/init.sql /opt/lab/init.sql
COPY db/config.sh db/entrypoint.sh /opt/lab/
RUN chmod 755 /docker-entrypoint-initdb.d/10-lab.sh /opt/lab/entrypoint.sh
USER postgres
ENTRYPOINT ["/opt/lab/entrypoint.sh"]
CMD ["postgres"]
