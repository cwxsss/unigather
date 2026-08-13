import argparse
import json
import shutil
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path


def parse_aliases(value):
    try:
        parsed = json.loads(value or "[]")
        return [str(item).strip() for item in parsed if str(item).strip()]
    except (TypeError, ValueError):
        return []


def main():
    parser = argparse.ArgumentParser(description="Merge only UniGather companies and contacts")
    parser.add_argument("current")
    parser.add_argument("legacy")
    parser.add_argument("--expected-companies", type=int, required=True)
    parser.add_argument("--expected-contacts", type=int, required=True)
    args = parser.parse_args()

    current_path = Path(args.current).resolve()
    legacy_path = Path(args.legacy).resolve()
    if not current_path.is_file() or not legacy_path.is_file():
        raise SystemExit("当前数据库或旧数据库不存在")

    backup_path = current_path.with_name(
        f"{current_path.name}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    )
    shutil.copy2(current_path, backup_path)

    current = sqlite3.connect(current_path)
    legacy = sqlite3.connect(f"file:{legacy_path.as_posix()}?mode=ro", uri=True)
    current.execute("PRAGMA foreign_keys=ON")
    try:
        current.execute("BEGIN IMMEDIATE")
        companies = {
            name.strip(): (company_id, parse_aliases(aliases))
            for company_id, name, aliases in current.execute(
                "SELECT id,name,aliases FROM companies"
            )
        }
        used_company_ids = {value[0] for value in companies.values()}
        email_map = {
            email.strip().lower(): contact_id
            for contact_id, email in current.execute(
                "SELECT id,email FROM company_contacts"
            )
        }
        used_contact_ids = set(email_map.values())

        for old_id, name, aliases_json, created_at in legacy.execute(
            "SELECT id,name,aliases,created_at FROM companies ORDER BY name"
        ):
            name = name.strip()
            old_aliases = parse_aliases(aliases_json)
            if name in companies:
                company_id, current_aliases = companies[name]
                merged_aliases = list(dict.fromkeys(current_aliases + old_aliases))
                current.execute(
                    "UPDATE companies SET aliases=? WHERE id=?",
                    (json.dumps(merged_aliases, ensure_ascii=False), company_id),
                )
            else:
                company_id = old_id if old_id not in used_company_ids else f"company-migrated-{uuid.uuid4()}"
                current.execute(
                    "INSERT INTO companies (id,name,aliases,created_at) VALUES (?,?,?,?)",
                    (company_id, name, json.dumps(old_aliases, ensure_ascii=False), created_at),
                )
                companies[name] = (company_id, old_aliases)
                used_company_ids.add(company_id)

        legacy_company_names = dict(legacy.execute("SELECT id,name FROM companies"))
        for old_contact_id, old_company_id, email, contact_name, phone, created_at in legacy.execute(
            "SELECT id,company_id,email,contact_name,phone,created_at FROM company_contacts ORDER BY email"
        ):
            normalized_email = email.strip().lower()
            if not normalized_email or normalized_email in email_map:
                continue
            company_name = legacy_company_names[old_company_id].strip()
            company_id = companies[company_name][0]
            contact_id = old_contact_id if old_contact_id not in used_contact_ids else f"contact-migrated-{uuid.uuid4()}"
            current.execute(
                "INSERT INTO company_contacts (id,company_id,email,contact_name,phone,created_at) VALUES (?,?,?,?,?,?)",
                (contact_id, company_id, normalized_email, contact_name, phone, created_at),
            )
            email_map[normalized_email] = contact_id
            used_contact_ids.add(contact_id)

        company_count = current.execute("SELECT COUNT(*) FROM companies").fetchone()[0]
        contact_count = current.execute("SELECT COUNT(*) FROM company_contacts").fetchone()[0]
        if company_count != args.expected_companies or contact_count != args.expected_contacts:
            raise RuntimeError(
                f"合并数量不符合预期：单位 {company_count}，联系人 {contact_count}"
            )
        current.commit()
        print(json.dumps({
            "backup": str(backup_path),
            "companies": company_count,
            "contacts": contact_count,
        }, ensure_ascii=False))
    except Exception:
        current.rollback()
        raise
    finally:
        legacy.close()
        current.close()


if __name__ == "__main__":
    main()
