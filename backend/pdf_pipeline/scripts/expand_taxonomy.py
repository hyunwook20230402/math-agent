import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

from pydantic import BaseModel, Field


class SynonymList(BaseModel):
    canonical: str
    synonyms_ko: list[str] = Field(default_factory=list, max_length=15)
    synonyms_en: list[str] = Field(default_factory=list, max_length=15)
    notes: Optional[str] = None


def _build_prompt(canonical, section, existing, max_synonyms):
    existing_str = ', '.join(f'{chr(34)}{s}{chr(34)}' for s in existing) if existing else 'none'
    section_label = {'concepts': 'math concept', 'skills': 'solving skill', 'bugs': 'error type'}.get(section, 'math term')
    return (
        f'Generate synonyms for the following Korean high school math {section_label} canonical term.\n\n'
        f'Canonical: "{canonical}"\n'
        f'Existing synonyms: {existing_str}\n\n'
        f'Requirements:\n'
        f'- Add only new synonyms not in existing list\n'
        f'- synonyms_ko: up to {max_synonyms} Korean synonyms (textbook, colloquial, abbreviations)\n'
        f'- synonyms_en: up to {max_synonyms} English synonyms (international math education standard)\n'
        f'- notes: one-line key characteristic of this canonical (null if none)\n'
        f'- Respond in JSON only'
    )


def _call_openai_text(prompt, schema):
    from openai import OpenAI
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        raise ValueError('OPENAI_API_KEY not set')
    client = OpenAI(api_key=api_key)
    model = os.environ.get('OPENAI_TAXONOMY_MODEL', 'gpt-4.1-mini')
    response = client.responses.parse(
        model=model,
        input=[{'role': 'user', 'content': prompt}],
        text_format=schema,
        temperature=0.3,
    )
    return response.output_parsed


def _compute_diff(taxonomy, section_name, max_synonyms):
    section = taxonomy.get(section_name, {})
    diff = {}
    total = len(section)
    for i, (canonical, existing_synonyms) in enumerate(section.items()):
        existing = list(existing_synonyms or [])
        print(f'  [{i+1}/{total}] {canonical} ... ', end='', flush=True)
        prompt = _build_prompt(canonical, section_name, existing, max_synonyms)
        try:
            result = _call_openai_text(prompt, SynonymList)
        except Exception as e:
            print(f'error: {e}')
            continue
        existing_set = set(existing)
        add_ko = [s for s in result.synonyms_ko if s and s not in existing_set]
        add_en = [s for s in result.synonyms_en if s and s not in existing_set]
        if add_ko or add_en:
            diff[canonical] = {'add_ko': add_ko, 'add_en': add_en}
            print(f'+{len(add_ko)}ko +{len(add_en)}en')
        else:
            print('no change')
        time.sleep(0.3)
    return diff


def _apply_diff(taxonomy, section_name, diff):
    import copy
    new_taxonomy = copy.deepcopy(taxonomy)
    section = new_taxonomy.setdefault(section_name, {})
    for canonical, changes in diff.items():
        existing = list(section.get(canonical) or [])
        existing_set = set(existing)
        for s in changes.get('add_ko', []) + changes.get('add_en', []):
            if s not in existing_set:
                existing.append(s)
                existing_set.add(s)
        section[canonical] = existing
    return new_taxonomy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', default=False)
    parser.add_argument('--apply', action='store_true', default=False)
    parser.add_argument('--section', choices=['concepts', 'skills', 'bugs', 'all'], default='all')
    parser.add_argument('--max-synonyms', type=int, default=15)
    args = parser.parse_args()

    if not args.apply:
        args.dry_run = True

    taxonomy_path = ROOT / 'data' / 'concept_taxonomy.json'
    backup_path = ROOT / 'data' / 'concept_taxonomy.backup.json'

    with open(taxonomy_path, encoding='utf-8') as f:
        taxonomy = json.load(f)

    sections = ['concepts', 'skills', 'bugs'] if args.section == 'all' else [args.section]
    all_diffs = {}

    for section_name in sections:
        if section_name not in taxonomy:
            print(f'section not found: {section_name}')
            continue
        print(f'\n=== {section_name} ({len(taxonomy[section_name])} canonicals) ===')
        diff = _compute_diff(taxonomy, section_name, args.max_synonyms)
        all_diffs[section_name] = diff

    print('\n\n=== diff summary ===')
    total_added = 0
    for section_name, diff in all_diffs.items():
        if not diff:
            print(f'{section_name}: no changes')
            continue
        print(f'\n{section_name}:')
        for canonical, changes in diff.items():
            ko = changes.get('add_ko', [])
            en = changes.get('add_en', [])
            print(f'  {canonical}:')
            if ko:
                print(f'    ko: {ko}')
            if en:
                print(f'    en: {en}')
            total_added += len(ko) + len(en)
    print(f'\ntotal {total_added} synonyms to add')

    if args.apply:
        with open(backup_path, 'w', encoding='utf-8') as f:
            json.dump(taxonomy, f, ensure_ascii=False, indent=2)
        print(f'\nbackup saved: {backup_path}')
        new_taxonomy = taxonomy
        for section_name, diff in all_diffs.items():
            new_taxonomy = _apply_diff(new_taxonomy, section_name, diff)
        with open(taxonomy_path, 'w', encoding='utf-8') as f:
            json.dump(new_taxonomy, f, ensure_ascii=False, indent=2)
        print(f'taxonomy updated: {taxonomy_path}')
        print('embedding cache will be rebuilt on next run.')
    else:
        print('\n(no --apply flag -> taxonomy file not modified)')


if __name__ == '__main__':
    main()
