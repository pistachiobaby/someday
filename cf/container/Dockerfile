FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libgomp1 libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

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
