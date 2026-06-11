# ECR Public mirror of the Docker official image — Docker Hub's
# unauthenticated pull limit 429s from shared CI/sandbox egress IPs.
FROM public.ecr.aws/docker/library/python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libgomp1 libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

# Some build environments (e.g. the CI sandbox) route egress through a
# TLS-intercepting proxy; extra-ca*.crt (untracked, optional — Dockerfile is
# listed only so the glob may match nothing) carries its CA so pip and the
# model bake below can verify HTTPS. Normal builds are unaffected.
COPY Dockerfile extra-ca*.crt /tmp/ca/
RUN cat /tmp/ca/*.crt >> /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN pip install --no-cache-dir \
      "yt-dlp[default,curl-cffi]" \
      paddlepaddle paddleocr \
      flask waitress

# Bake the OCR models into the image so cold containers don't download them.
RUN python -c "from paddleocr import PaddleOCR; \
    PaddleOCR(lang='japan', use_textline_orientation=True, enable_mkldnn=False); \
    PaddleOCR(lang='en', use_textline_orientation=True, enable_mkldnn=False)"

COPY server.py /app/server.py
WORKDIR /app
EXPOSE 8080
CMD ["python", "server.py"]
