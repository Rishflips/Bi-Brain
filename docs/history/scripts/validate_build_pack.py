"""Validate this specification pack using Python's standard library.

The schema checker intentionally supports only the JSON Schema keywords used
by brain.schema.json. It rejects unfamiliar validation keywords instead of
silently claiming full JSON Schema support. Application tests are separate.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        ERRORS.append(message)


def read_json(relative: str):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def validate(value, schema: dict, root: dict, path: str = "$") -> None:
    supported = {
        "$schema", "$id", "$defs", "$ref", "title", "description", "type",
        "properties", "required", "additionalProperties", "items", "enum",
        "const", "minimum", "minLength", "maxLength", "pattern", "format",
    }
    check(not (set(schema) - supported), f"{path}: unsupported schema keywords")
    if "$ref" in schema:
        reference = schema["$ref"]
        check(reference.startswith("#/"), f"{path}: only local references supported")
        if not reference.startswith("#/"):
            return
        target = root
        for part in reference[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        validate(value, target, root, path)
        return
    kind = schema.get("type")
    type_tests = {
        "object": lambda: isinstance(value, dict),
        "array": lambda: isinstance(value, list),
        "string": lambda: isinstance(value, str),
        "integer": lambda: isinstance(value, int) and not isinstance(value, bool),
        "boolean": lambda: isinstance(value, bool),
    }
    if kind:
        check(kind in type_tests, f"{path}: unsupported type {kind}")
        if kind not in type_tests or not type_tests[kind]():
            check(False, f"{path}: expected {kind}")
            return
    if "const" in schema:
        check(type(value) is type(schema["const"]) and value == schema["const"], f"{path}: wrong constant")
    if "enum" in schema:
        check(value in schema["enum"], f"{path}: invalid enum")
    if kind == "object":
        check(set(schema.get("required", [])) <= set(value), f"{path}: missing required keys")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            check(set(value) <= set(properties), f"{path}: unexpected keys")
        for key, child in value.items():
            if key in properties:
                validate(child, properties[key], root, f"{path}.{key}")
    elif kind == "array":
        for index, child in enumerate(value):
            validate(child, schema["items"], root, f"{path}[{index}]")
    elif kind == "string":
        check(len(value) >= schema.get("minLength", 0), f"{path}: too short")
        check(len(value) <= schema.get("maxLength", sys.maxsize), f"{path}: too long")
        if "pattern" in schema:
            check(re.search(schema["pattern"], value) is not None, f"{path}: pattern mismatch")
        if schema.get("format") == "date-time":
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                check(parsed.tzinfo is not None, f"{path}: missing time zone")
            except ValueError:
                check(False, f"{path}: invalid date-time")
    elif kind == "integer":
        check(value >= schema.get("minimum", -sys.maxsize), f"{path}: below minimum")


def main() -> int:
    markdown = list(ROOT.rglob("*.md"))
    for doc in markdown:
        content = doc.read_text(encoding="utf-8")
        for link in re.findall(r"\]\(([^)]+)\)", content):
            target = link.split("#", 1)[0].strip("<>")
            if not target or re.match(r"^[a-zA-Z]+:", target):
                continue
            check((doc.parent / target).exists(), f"{doc.relative_to(ROOT)}: broken link {target}")

    for asset in ["design/reference-light.png", "design/reference-dark.png"]:
        check((ROOT / asset).is_file(), f"Missing design reference: {asset}")

    schema = read_json("contracts/brain.schema.json")
    data = read_json("fixtures/beta-launch.json")
    scenarios = read_json("evals/scenarios.json")
    validate(data, schema, schema)
    check(data.get("synthetic") is True, "Fixture must be marked synthetic")
    check(scenarios.get("synthetic") is True, "Scenarios must be marked synthetic")

    collections = ["projects", "sources", "goals", "briefs", "proposals", "receipts"]
    ids = [item["id"] for name in collections for item in data[name]]
    check(len(ids) == len(set(ids)), "Duplicate fixture IDs")
    projects = {item["id"] for item in data["projects"]}
    sources = {(item["id"], item["version"]): item for item in data["sources"]}
    goals = {item["id"]: item for item in data["goals"]}
    briefs = {item["id"]: item for item in data["briefs"]}

    def evidence_check(evidence: dict, project_id: str, location: str) -> None:
        source = sources.get((evidence["source_id"], evidence["source_version"]))
        check(source is not None, f"{location}: missing source version")
        if source is None:
            return
        check(source["project_id"] == project_id, f"{location}: cross-project evidence")
        start, end = evidence["start"], evidence["end"]
        check(0 <= start < end <= len(source["body"]), f"{location}: invalid code-point offsets")
        check(source["body"][start:end] == evidence["quote"], f"{location}: quote mismatch")

    for name in collections[1:]:
        for item in data[name]:
            check(item["project_id"] in projects, f"{item['id']}: unknown project")
            for evidence in item.get("evidence", []):
                evidence_check(evidence, item["project_id"], item["id"])
            for claim in item.get("items", []):
                if claim["epistemic_status"] == "supported":
                    check(bool(claim["evidence"]), f"{item['id']}: unsupported factual item")
                for evidence in claim["evidence"]:
                    evidence_check(evidence, item["project_id"], item["id"])
            if name == "proposals":
                goal = goals.get(item["goal_id"])
                brief = briefs.get(item["base_brief_id"])
                check(goal is not None and goal["project_id"] == item["project_id"], f"{item['id']}: invalid goal")
                check(brief is not None and brief["project_id"] == item["project_id"], f"{item['id']}: invalid base brief")
                if brief:
                    check(item["base_version"] == brief["version"], f"{item['id']}: wrong base version")
            if name == "receipts":
                check(set(item["changed_ids"]) <= set(ids), f"{item['id']}: unknown changed object")

    known_source_ids = {key[0] for key in sources}
    scenario_ids: set[str] = set()
    requirement_ids = set(re.findall(r"\| (P\d{2}) \|", (ROOT / "docs/PRODUCT.md").read_text(encoding="utf-8")))
    covered: set[str] = set()
    for case in scenarios["scenarios"]:
        check(case["id"] not in scenario_ids, f"Duplicate scenario {case['id']}")
        scenario_ids.add(case["id"])
        check(set(case["source_ids"]) <= known_source_ids, f"{case['id']}: missing fixture source")
        check(set(case["requirements"]) <= requirement_ids, f"{case['id']}: unknown requirement")
        check(all(case.get(field) for field in ["given", "when", "then"]), f"{case['id']}: incomplete scenario")
        covered.update(case["requirements"])
    check(requirement_ids <= covered, "Some product requirements have no evaluation scenario")

    if ERRORS:
        for error in ERRORS:
            print("FAIL:", error)
        return 1
    print(f"PASS: {len(markdown)} Markdown files; local links and design references exist.")
    print(f"PASS: fixture validates against supported schema keywords; {len(sources)} source versions and evidence spans checked.")
    print(f"PASS: {len(scenario_ids)} scenarios cover {len(requirement_ids)} product requirements.")
    print("Application implementation and live integrations are not tested by this script.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
