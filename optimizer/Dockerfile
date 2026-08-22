FROM python:3.12-slim

WORKDIR /app

# Install dependencies as their own layer so source edits do not trigger a
# rebuild of the (large) OR-Tools wheel.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
