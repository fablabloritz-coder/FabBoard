FROM python:3.11-slim

LABEL maintainer="Fablab Loritz"
LABEL description="FabBoard - Dashboard TV pour Fablab"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

COPY . /app

RUN mkdir -p /app/data \
    && chown -R app:app /app

USER app

EXPOSE 5580

CMD ["waitress-serve", "--listen=0.0.0.0:5580", "app:app"]
