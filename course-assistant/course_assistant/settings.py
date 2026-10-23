"""Course assistant settings. Keep provider secrets outside the source tree."""
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(os.getenv("COURSE_ASSISTANT_ENV_FILE", str(BASE_DIR / ".env")))
STATE_DIR = Path(os.getenv("COURSE_ASSISTANT_STATE_DIR", str(BASE_DIR / "var")))
STATE_DIR.mkdir(parents=True, exist_ok=True)

DEBUG = os.getenv("DJANGO_DEBUG", "true").lower() in {"true", "1", "yes"}
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError("DJANGO_DEBUG=false 时必须设置 DJANGO_SECRET_KEY。")
    SECRET_KEY = secrets.token_urlsafe(48)
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv("DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost,[::1]").split(",")
    if host.strip()
]
INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "tutor.apps.TutorConfig",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "course_assistant.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": ["django.template.context_processors.request"],
        },
    }
]
WSGI_APPLICATION = "course_assistant.wsgi.application"
ASGI_APPLICATION = "course_assistant.asgi.application"
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": STATE_DIR / "db.sqlite3"}}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
LANGUAGE_CODE = "zh-hans"
TIME_ZONE = os.getenv("TIME_ZONE", "Asia/Seoul")
USE_I18N = True
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = STATE_DIR / "static"
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
DATA_UPLOAD_MAX_MEMORY_SIZE = 16 * 1024
X_FRAME_OPTIONS = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True
CSRF_FAILURE_VIEW = "tutor.views.csrf_failure"

# Embedding credentials are separate: many chat providers do not offer embeddings.
KNOWLEDGE_DIR = BASE_DIR / "knowledge"
RAG_INDEX_DIR = STATE_DIR / "index"
RAG_EMBEDDING_BACKEND = os.getenv("RAG_EMBEDDING_BACKEND", "fastembed")
RAG_EMBEDDING_MODEL = os.getenv("RAG_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
RAG_EMBEDDING_BASE_URL = os.getenv("RAG_EMBEDDING_BASE_URL", "https://api.openai.com/v1")
RAG_EMBEDDING_API_KEY = os.getenv("RAG_EMBEDDING_API_KEY", "")
RAG_TOP_K = int(os.getenv("RAG_TOP_K", "4"))
RAG_CHUNK_SIZE = int(os.getenv("RAG_CHUNK_SIZE", "650"))
RAG_CHUNK_OVERLAP = int(os.getenv("RAG_CHUNK_OVERLAP", "100"))
RAG_MIN_SCORE = float(os.getenv("RAG_MIN_SCORE", "0.45"))
RAG_TIMEOUT = int(os.getenv("RAG_TIMEOUT", "60"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
MODEL_NAME = os.getenv("MODEL_NAME", "qwen-plus")

# Local model files only; no tracing of students' questions to a third-party service.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("LANGCHAIN_TRACING_V2", "false")
