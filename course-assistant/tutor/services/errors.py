class RAGError(Exception):
    """An actionable error that is safe to return to the web client."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
