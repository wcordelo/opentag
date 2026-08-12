import importlib.util
import os
from pathlib import Path
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("graphify_builder", ROOT / "graphify-builder.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GraphifyBuilderPolicyTests(unittest.TestCase):
    def test_repository_org_allowlist_is_fail_closed(self):
        original = os.environ.get("GRAPHIFY_ALLOWED_REPO_ORGS")
        try:
            os.environ["GRAPHIFY_ALLOWED_REPO_ORGS"] = "wcordelo, trusted-org"
            self.assertTrue(MODULE.repo_org_allowed("https://github.com/wcordelo/opentag.git"))
            self.assertTrue(MODULE.repo_org_allowed("https://github.com/TRUSTED-ORG/repo.git"))
            self.assertFalse(MODULE.repo_org_allowed("https://github.com/other/repo.git"))
            os.environ.pop("GRAPHIFY_ALLOWED_REPO_ORGS", None)
            self.assertFalse(MODULE.repo_org_allowed("https://github.com/wcordelo/opentag.git"))
        finally:
            if original is None:
                os.environ.pop("GRAPHIFY_ALLOWED_REPO_ORGS", None)
            else:
                os.environ["GRAPHIFY_ALLOWED_REPO_ORGS"] = original

    def test_artifact_key_rejects_paths_and_wrong_revisions(self):
        good = "code-graphs/opentag/0123456789012345678901234567890123456789"
        self.assertTrue(MODULE.valid_artifact_key(good))
        self.assertFalse(MODULE.valid_artifact_key("../secret"))
        self.assertFalse(MODULE.valid_artifact_key("code-graphs/../0123456789012345678901234567890123456789"))
        self.assertFalse(MODULE.valid_artifact_key("code-graphs/opentag/not-a-commit"))

    def test_query_entrypoint_uses_worker_owned_read_only_mount(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        source = (ROOT / "start-query.sh").read_text(encoding="utf-8")
        self.assertIn("docker.io/cloudflare/sandbox:0.12.4-python", dockerfile)
        self.assertIn("PATH=/usr/local/python/bin", dockerfile)
        self.assertIn("exec python3 /app/graphify-api.py", source)
        self.assertNotIn("tigrisfs", source)
        self.assertNotIn("AWS_ACCESS_KEY_ID", source)
        self.assertNotIn("R2_READ_ACCESS_KEY_ID", source)

    def test_restricted_container_roles_intercept_https(self):
        source = (ROOT / "src" / "container.ts").read_text(encoding="utf-8")
        self.assertEqual(source.count("interceptHttps = true"), 2)
        self.assertIn('allowedHosts = ["*.r2.cloudflarestorage.com"]', source)
        self.assertIn('allowedHosts = ["github.com", "*.github.com", "*.githubusercontent.com"]', source)

    def test_source_archive_is_bounded_and_non_recursive(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            repo.mkdir()
            (repo / "README.md").write_text("readme", encoding="utf-8")
            (repo / "src").mkdir()
            (repo / "src" / "main.py").write_text("print('ok')", encoding="utf-8")
            archive = Path(temp) / "source.tar.gz"

            count, size = MODULE.archive_source(repo, archive)

            self.assertEqual(count, 2)
            self.assertEqual(size, len("readme") + len("print('ok')"))
            with tarfile.open(archive, "r:gz") as stream:
                self.assertEqual(
                    sorted(member.name for member in stream.getmembers()),
                    ["source/README.md", "source/src/main.py"],
                )

    def test_source_archive_is_reproducible_for_the_same_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            repo.mkdir()
            file = repo / "README.md"
            file.write_text("stable", encoding="utf-8")
            first = Path(temp) / "first.tar.gz"
            second = Path(temp) / "second.tar.gz"

            MODULE.archive_source(repo, first)
            os.utime(file, (123456789, 123456789))
            MODULE.archive_source(repo, second)

            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_image_build_cannot_override_the_graphify_source_pin(self):
        source = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn('ARG GRAPHIFY_COMMIT=00efd6e7969837ae4a9f11d8d504dcd3b20b09df', source)
        self.assertIn('test "$GRAPHIFY_COMMIT" = "00efd6e7969837ae4a9f11d8d504dcd3b20b09df"', source)
        self.assertIn("s3fs", source)
        self.assertNotIn("TIGRISFS", source)

    def test_post_clone_revision_check_uses_scrubbed_environment(self):
        source = (ROOT / "graphify-builder.py").read_text(encoding="utf-8")
        self.assertIn('environment.pop("GITHUB_TOKEN", None)', source)
        self.assertIn('stderr=subprocess.DEVNULL,\n                env=environment', source)

    def test_artifact_publish_uses_atomic_create_if_absent(self):
        source = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")
        self.assertIn('onlyIf: { etagDoesNotMatch: "*" }', source)
        self.assertIn("throw new Error(`immutable Graphify ${kind} conflict`)", source)

    def test_path_relation_selection_handles_parallel_edges_deterministically(self):
        source = (ROOT / "graphify-api.py").read_text(encoding="utf-8")
        self.assertIn("def edge_attributes", source)
        self.assertIn("graph.is_multigraph()", source)
        self.assertIn("choose a stable representative", source)


if __name__ == "__main__":
    unittest.main()
