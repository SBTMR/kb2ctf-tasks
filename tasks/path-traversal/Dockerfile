FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN groupadd --gid 10001 lab && useradd --uid 10001 --gid lab --no-create-home lab
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ /app/
RUN python /app/seed.py && chmod 444 /flag.txt
RUN mkdir -p /var/lib/lab/storage && chown 10001:10001 /var/lib/lab/storage
USER 10001:10001
EXPOSE 8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "15", "--access-logfile", "/dev/null", "main:app"]
