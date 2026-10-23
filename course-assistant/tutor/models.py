from django.db import models


class QueryRecord(models.Model):
    """Store each successful answer with the excerpts actually used."""

    question = models.TextField()
    answer = models.TextField()
    sources = models.JSONField(default=list)
    mode = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
