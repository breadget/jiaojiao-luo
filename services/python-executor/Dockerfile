FROM python:3.12.10-slim-bookworm AS reportlab-builder

ARG REPORTLAB_VERSION=4.4.4
ARG CHARSET_NORMALIZER_VERSION=3.5.1

RUN python -m pip install --no-cache-dir --no-deps --target /opt/reportlab \
      "reportlab==${REPORTLAB_VERSION}" \
      "charset-normalizer==${CHARSET_NORMALIZER_VERSION}"

FROM python:3.12.10-slim-bookworm

ARG NUMPY_VERSION=2.2.6
ARG PANDAS_VERSION=2.2.3
ARG MATPLOTLIB_VERSION=3.10.3
ARG PILLOW_VERSION=11.2.1
ARG OPENPYXL_VERSION=3.1.5
ARG PYPDF_VERSION=5.6.0
ARG PYTHON_DOCX_VERSION=1.2.0
ARG PYTHON_PPTX_VERSION=1.0.2
ARG XLRD_VERSION=2.0.2
ARG STRIPRTF_VERSION=0.0.29
ARG ODFPY_VERSION=1.4.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends antiword catdoc \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir \
      "numpy==${NUMPY_VERSION}" \
      "pandas==${PANDAS_VERSION}" \
      "matplotlib==${MATPLOTLIB_VERSION}" \
      "pillow==${PILLOW_VERSION}" \
      "openpyxl==${OPENPYXL_VERSION}" \
      "pypdf==${PYPDF_VERSION}" \
      "python-docx==${PYTHON_DOCX_VERSION}" \
      "python-pptx==${PYTHON_PPTX_VERSION}" \
      "xlrd==${XLRD_VERSION}" \
      "striprtf==${STRIPRTF_VERSION}" \
      "odfpy==${ODFPY_VERSION}" \
    && rm -rf \
      /root/.cache \
      /usr/local/bin/pip* \
      /usr/local/lib/python3.12/site-packages/pip* \
      /usr/local/lib/python3.12/site-packages/setuptools* \
      /usr/local/lib/python3.12/site-packages/wheel* \
    && rm -f /bin/sh /bin/dash /bin/bash \
    && rm -rf /usr/bin/apt* /usr/bin/dpkg* /usr/bin/curl /usr/bin/wget \
    && mkdir -p /workspace/input /workspace/output /opt/executor \
    && chown -R 65532:65532 /workspace /opt/executor \
    && chmod 0555 /workspace /workspace/input /opt/executor

COPY --from=reportlab-builder --chown=0:0 /opt/reportlab/ /usr/local/lib/python3.12/site-packages/
COPY --chown=65532:65532 --chmod=0444 image/validate_png.py /opt/executor/validate_png.py
COPY --chown=65532:65532 --chmod=0444 image/validate_xlsx.py /opt/executor/validate_xlsx.py
COPY --chown=65532:65532 --chmod=0444 image/validate_pdf.py /opt/executor/validate_pdf.py
COPY --chown=65532:65532 --chmod=0444 image/validate_ooxml.py /opt/executor/validate_ooxml.py

ENV HOME=/tmp \
    LANG=C.UTF-8 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=UTC

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["python", "-I", "-B", "-u"]
CMD ["/workspace/main.py"]
