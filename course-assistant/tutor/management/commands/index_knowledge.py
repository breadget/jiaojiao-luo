from django.core.management.base import BaseCommand, CommandError

from tutor.services import RAGError, build_index


class Command(BaseCommand):
    help = "读取 knowledge 目录中的 PDF，切分内容并建立持久化 FAISS 语义向量库。"

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true", help="强制重新生成所有文档向量。")

    def handle(self, *args, **options):
        self.stdout.write("正在检查知识库；首次运行需要下载本地 Embedding 模型。")
        try:
            status = build_index(force=options["force"])
        except RAGError as exc:
            raise CommandError(f"{exc.message}（{exc.code}）") from None
        self.stdout.write(
            self.style.SUCCESS(
                f"知识库就绪：{status['document_count']} 份 PDF，{status['page_count']} 页，"
                f"{status['chunk_count']} 个片段；Embedding：{status['embedding_model']}。"
            )
        )
