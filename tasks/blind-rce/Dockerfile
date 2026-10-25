FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN groupadd --gid 10001 lab && useradd --uid 10001 --gid lab --no-create-home lab
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping && setcap -r /usr/bin/ping && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ /app/
USER 10001:10001
EXPOSE 51338
CMD ["gunicorn", "--bind", "0.0.0.0:51338", "--workers", "1", "--threads", "4", "--timeout", "15", "--access-logfile", "/dev/null", "main:app"]
