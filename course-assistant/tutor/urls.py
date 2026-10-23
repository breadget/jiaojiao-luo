from django.urls import path

from . import views

urlpatterns = [
    path("", views.home, name="home"),
    path("api/status/", views.status, name="status"),
    path("api/ask/", views.ask, name="ask"),
    path("api/retrieve/", views.retrieve_sources, name="retrieve"),
]
