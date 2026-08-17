import os
import runpy
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


HELPER = Path(__file__).resolve().parents[1] / "bin" / "navbar-cat-cursor"
CURSOR = runpy.run_path(str(HELPER), run_name="navbar_cat_cursor")


class CursorHelperTests(unittest.TestCase):
    def test_interval_is_clamped_and_invalid_values_keep_current(self):
        clamp = CURSOR["clamp_interval"]
        self.assertEqual(clamp("5", 100), CURSOR["MIN_INTERVAL_MS"])
        self.assertEqual(clamp("5000", 100), CURSOR["MAX_INTERVAL_MS"])
        self.assertEqual(clamp("250.9", 100), 250)
        self.assertEqual(clamp("nan", 100), 100)
        self.assertEqual(clamp("inf", 100), 100)
        self.assertEqual(clamp("invalid", 100), 100)

    def test_socket_path_is_scoped_to_hyprland_runtime(self):
        with tempfile.TemporaryDirectory() as runtime:
            expected = Path(runtime) / "hypr" / "test-signature" / ".socket.sock"
            expected.parent.mkdir(parents=True)
            expected.touch()
            env = {
                "XDG_RUNTIME_DIR": runtime,
                "HYPRLAND_INSTANCE_SIGNATURE": "test-signature",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(CURSOR["socket_path"](), str(expected))

    def test_sample_sends_only_cursorpos_and_parses_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "hypr.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            received = []

            def respond():
                connection, _ = server.accept()
                with connection:
                    received.append(connection.recv(64))
                    connection.sendall(b"123, 456\n")
                server.close()

            thread = threading.Thread(target=respond)
            thread.start()
            self.assertEqual(CURSOR["sample"](path), (123, 456))
            thread.join(timeout=1)
            self.assertEqual(received, [b"cursorpos"])

    def test_sample_fails_closed_for_bad_reply_or_missing_socket(self):
        self.assertIsNone(CURSOR["sample"]("/definitely/not/a/socket"))

        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "hypr.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)

            def respond():
                connection, _ = server.accept()
                with connection:
                    connection.recv(64)
                    connection.sendall(b"malformed")
                server.close()

            thread = threading.Thread(target=respond)
            thread.start()
            self.assertIsNone(CURSOR["sample"](path))
            thread.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
