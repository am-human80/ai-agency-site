#!/usr/bin/env python3
"""Run the Clickthrough Digital FAQ RAG evaluation harness.
Usage:
  python run_faq_rag_evaluation.py
"""
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
SPEC_PATH = os.path.join(PROJECT_DIR, "evaluation_specification.json")
DATASET_PATH = os.path.join(PROJECT_DIR, "rag_eval_questions.json")
REPORT_PATH = os.path.join(PROJECT_DIR, "evaluation_report.json")

TIMEOUT_SEC = 10


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def post_question(endpoint: str, message: str) -> Dict[str, Any]:
    payload = json.dumps({"message": message}).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
        return json.load(resp)


def extract_response_text(resp: Dict[str, Any]) -> str:
    text = resp.get("response")
    if isinstance(text, str):
        return text
    metadata = resp.get("metadata", {})
    return metadata.get("reply", "") or ""


def normalize(text: str) -> str:
    return text.lower()


class EvaluationRunner:
    def __init__(self, spec: Dict[str, Any], cases: List[Dict[str, Any]]):
        self.spec = spec
        self.cases = cases
        self.report: Dict[str, Any] = {
            "feature_name": spec.get("feature_name"),
            "tests_run": 0,
            "passed": 0,
            "failed": 0,
            "retrieval_accuracy": None,
            "citation_coverage": None,
            "hallucination_rate": None,
            "fallback_correctness": None,
            "detailed_results": [],
            "final_result": None,
        }
        self.supported_ratios: List[float] = []
        self.citation_targets = 0
        self.citation_hits = 0
        self.fallback_targets = 0
        self.fallback_hits = 0

    def run(self):
        endpoint = self.spec.get("target_endpoint")
        if not endpoint:
            raise ValueError("target_endpoint missing in specification")

        for case in self.cases:
            result = self.process_case(endpoint, case)
            self.report["detailed_results"].append(result)

        self.finalize_report()
        write_json(REPORT_PATH, self.report)

    def process_case(self, endpoint: str, case: Dict[str, Any]) -> Dict[str, Any]:
        question = case.get("question", "")
        case_id = case.get("id") or question
        supported = bool(case.get("supported", True))
        expected_keywords = [kw.lower() for kw in case.get("expected_keywords", [])]
        requires_citation = bool(case.get("requires_citation", False))
        fallback_text = case.get("fallback", "")

        response_text = ""
        sources: Optional[List[str]] = None
        error = None
        success = False
        keywords_matched = 0
        keyword_ratio = 0.0
        citation_found = False
        fallback_used = False

        try:
            resp_data = post_question(endpoint, question)
            response_text = extract_response_text(resp_data)
            metadata = resp_data.get("metadata", {})
            sources = resp_data.get("sources") or metadata.get("sources")
            if isinstance(sources, str):
                sources = [sources]
            if sources:
                citation_found = True

            norm_text = normalize(response_text)
            if expected_keywords:
                matches = [kw for kw in expected_keywords if kw in norm_text]
                keywords_matched = len(matches)
                keyword_ratio = keywords_matched / len(expected_keywords)
            else:
                keyword_ratio = 1.0

            if not supported and fallback_text:
                fallback_used = fallback_text.lower() in norm_text

            fallback_used = fallback_used or (not supported and not response_text.strip())

            if supported:
                keyword_success = keyword_ratio >= 0.5
                citation_ok = not requires_citation or citation_found
                success = keyword_success and citation_ok
            else:
                success = fallback_used
        except urllib.error.HTTPError as exc:
            error = f"HTTPError: {exc.code}"
        except urllib.error.URLError as exc:
            error = f"URLError: {exc.reason}"
        except Exception as exc:  # pragma: no cover - best effort
            error = str(exc)

        self.report["tests_run"] += 1
        if success:
            self.report["passed"] += 1
        else:
            self.report["failed"] += 1
        if supported:
            self.supported_ratios.append(keyword_ratio)
        if supported and requires_citation:
            self.citation_targets += 1
            if citation_found:
                self.citation_hits += 1
        if not supported:
            self.fallback_targets += 1
            if fallback_used:
                self.fallback_hits += 1

        return {
            "id": case_id,
            "question": question,
            "supported": supported,
            "keywords_expected": len(expected_keywords),
            "keywords_matched": keywords_matched,
            "keyword_ratio": round(keyword_ratio, 3),
            "requires_citation": requires_citation,
            "citation_present": citation_found,
            "fallback_expected": bool(fallback_text),
            "fallback_triggered": fallback_used,
            "pass": success,
            "response": response_text,
            "sources": sources,
            "error": error,
        }

    def finalize_report(self):
        tests = self.report["tests_run"] or 1
        failed = self.report["failed"]
        passed = self.report["passed"]
        self.report["hallucination_rate"] = round(failed / tests, 3)
        if self.supported_ratios:
            avg_ratio = sum(self.supported_ratios) / len(self.supported_ratios)
            self.report["retrieval_accuracy"] = round(avg_ratio, 3)
        if self.citation_targets:
            self.report["citation_coverage"] = round(self.citation_hits / self.citation_targets, 3)
        if self.fallback_targets:
            self.report["fallback_correctness"] = round(self.fallback_hits / self.fallback_targets, 3)
        self.report["final_result"] = "PASS" if failed == 0 else "FAIL"


def write_json(path: str, payload: Any) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)


def main() -> None:
    try:
        spec = load_json(SPEC_PATH)
    except FileNotFoundError as exc:
        print(f"Specification file not found: {exc}")
        sys.exit(1)

    try:
        cases = load_json(DATASET_PATH)
    except FileNotFoundError as exc:
        print(f"Dataset file not found: {exc}")
        sys.exit(1)

    runner = EvaluationRunner(spec, cases)
    try:
        runner.run()
    except Exception as exc:
        print(f"Evaluation failed: {exc}")
        sys.exit(1)
    print("Evaluation completed. See evaluation_report.json for results.")


if __name__ == "__main__":
    main()
