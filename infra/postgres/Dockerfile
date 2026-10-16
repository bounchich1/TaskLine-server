FROM postgres:18.3-alpine

RUN apk add --no-cache 'pgbackrest~=2.57' \
    && install -d -o postgres -g postgres -m 750 /var/log/pgbackrest /var/spool/pgbackrest /tmp/pgbackrest \
    && install -d -o root -g postgres -m 750 /etc/pgbackrest

ENV PGBACKREST_STANZA=main \
    PGBACKREST_LOG_PATH=/var/log/pgbackrest \
    PGBACKREST_LOCK_PATH=/tmp/pgbackrest \
    PGBACKREST_SPOOL_PATH=/var/spool/pgbackrest \
    PGBACKREST_LOG_LEVEL_CONSOLE=warn \
    PGBACKREST_LOG_LEVEL_FILE=info \
    PGBACKREST_COMPRESS_TYPE=zst \
    PGBACKREST_START_FAST=y

COPY --chmod=755 pgbackrest-config.sh /usr/local/bin/pgbackrest-config
COPY --chmod=755 pgbackrest-archive.sh /usr/local/bin/pgbackrest-archive
COPY --chmod=755 entrypoint.sh /usr/local/bin/taskline-entrypoint
COPY --chmod=755 standby-entrypoint.sh /usr/local/bin/standby-entrypoint
COPY --chmod=755 replication-hba.sh /usr/local/bin/replication-hba
COPY --chmod=755 replication-hba.sh /docker-entrypoint-initdb.d/10-replication-hba.sh

ENTRYPOINT ["taskline-entrypoint"]
CMD ["postgres"]
