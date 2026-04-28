from django.core.management import BaseCommand
from django.db import transaction

from documents.management.commands.mixins import ProgressBarMixin
from documents.tasks import index_optimize
from documents.tasks import index_reindex


class Command(ProgressBarMixin, BaseCommand):
    help = "Manages the document index."

    def add_arguments(self, parser):
        parser.add_argument(
            "command",
            choices=["reindex", "optimize"],
        )
        parser.add_argument(
            "--no-meili",
            action="store_true",
            default=False,
            help="Skip Meilisearch reindex (Whoosh only).",
        )
        parser.add_argument(
            "--meili-only",
            action="store_true",
            default=False,
            help="Reindex Meilisearch only, skip Whoosh.",
        )
        self.add_argument_progress_bar_mixin(parser)

    def handle(self, *args, **options):
        self.handle_progress_bar_mixin(**options)
        no_meili = options.get("no_meili", False)
        meili_only = options.get("meili_only", False)

        with transaction.atomic():
            if options["command"] == "reindex":
                if not meili_only:
                    self.stdout.write("Reindexing Whoosh…")
                    index_reindex(progress_bar_disable=self.no_progress_bar)
                    self.stdout.write(self.style.SUCCESS("Whoosh reindex complete."))

                if not no_meili:
                    self.stdout.write("Reindexing Meilisearch…")
                    from documents.meili import reindex_all
                    reindex_all(progress_bar_disable=self.no_progress_bar)
                    self.stdout.write(self.style.SUCCESS("Meilisearch reindex complete."))

            elif options["command"] == "optimize":
                index_optimize()
