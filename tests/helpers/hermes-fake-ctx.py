# A stand-in for Hermes: imports the plugin from the folder given as argv[1], records what register(ctx) registers,
# runs the steps read from stdin and prints one JSON line. Never launches Hermes. Run with python -I.
import ast, importlib.util, json, os, sys, time, types

plugin_dir = sys.argv[1]
plugin_file = os.path.join(plugin_dir, "__init__.py")
# The plugin reads its key through agent.secret_scope.get_secret when Hermes provides it; here that module is a stub over the environment.
scope = types.ModuleType("agent.secret_scope")
scope.get_secret = lambda name: os.environ.get(name)
agent = types.ModuleType("agent")
agent.secret_scope = scope
sys.modules["agent"] = agent
sys.modules["agent.secret_scope"] = scope

# Every module the plugin's own import statements name, anywhere in the file (so a late import inside a function counts too).
with open(plugin_file, encoding="utf-8") as fh:
    tree = ast.parse(fh.read())
imports = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        imports.update(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom) and node.module:
        imports.add(node.module)
imports = sorted(imports)
stdlib_only = all(name.split(".")[0] in sys.stdlib_module_names or name.startswith("agent") for name in imports)

spec = importlib.util.spec_from_file_location("bibrain_plugin", plugin_file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

hooks = {}
class Ctx:
    def register_hook(self, name, callback, **kw):
        hooks[name] = callback
module.register(Ctx())

# Bytes, decoded as UTF-8 ourselves: with -I the locale decides sys.stdin's encoding, and on Windows that would mangle non-ASCII prompts.
scenario = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
results, raised, elapsed = [], [], []
for step in scenario.get("steps", []):
    started = time.monotonic()
    try:
        results.append(hooks[step["hook"]](**step["kwargs"]))
    except Exception as e:  # a hook must never raise; record it so the test can fail
        results.append(None)
        raised.append(repr(e))
    elapsed.append(int((time.monotonic() - started) * 1000))
pure = {}
for name, inputs in scenario.get("pure", {}).items():
    out = []
    for x in inputs:
        try:
            out.append(getattr(module, name)(x))
        except Exception as e:  # pure helpers may raise by contract (api_origin); report the class name
            out.append(type(e).__name__)
    pure[name] = out
print(json.dumps({"hooks": list(hooks), "imports": imports, "stdlib_only": stdlib_only, "results": results, "raised": raised, "elapsed_ms": elapsed, "pure": pure}))
