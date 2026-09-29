FROM python:3.12-slim

# No mail credentials ever enter this image. The corpus arrives already exported and
# redacted on the host; the container sees text that has been through redact.py.
RUN useradd -m -u 10001 runner
WORKDIR /work
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt || true
USER runner
ENTRYPOINT ["python3", "/work/src/run.py"]
