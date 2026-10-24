"""Run the hidden suite against the agent's sheet.py and emit JSON."""
import json, os, sys, unittest, io, importlib, traceback

os.chdir(os.environ.get("GRADE_DIR", "/home/user/work"))
sys.path.insert(0, os.getcwd())

out = {"total": 0, "passed": 0, "failed": 0, "errors": 0, "import_ok": False,
       "failures": [], "note": ""}

MODULE = os.environ.get("GRADE_MODULE", "sheet")

try:
    importlib.invalidate_caches()
    importlib.import_module(MODULE)
    out["import_ok"] = True
except Exception:
    out["note"] = f"import of {MODULE}.py failed:\n" + traceback.format_exc()[-2000:]
    print(json.dumps(out)); sys.exit(0)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    suite = unittest.defaultTestLoader.loadTestsFromName("test_hidden")
except Exception:
    out["note"] = "could not load hidden suite:\n" + traceback.format_exc()[-2000:]
    print(json.dumps(out)); sys.exit(0)

buf = io.StringIO()
res = unittest.TextTestRunner(stream=buf, verbosity=0).run(suite)
out["total"] = res.testsRun
out["failed"] = len(res.failures)
out["errors"] = len(res.errors)
out["passed"] = res.testsRun - len(res.failures) - len(res.errors)
out["failures"] = [t.id() for t, _ in res.failures] + [t.id() for t, _ in res.errors]
print(json.dumps(out))
