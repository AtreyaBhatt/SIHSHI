import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def bank_login_payload() -> dict:
    """Real output from the extension's redaction engine, not a hand-written stub.

    Regenerate with:
        cd extension && ATHENA_EMIT_PAYLOAD=../server/tests/fixtures/bank_login_payload.json \
            npm run test:redaction
    """
    return json.loads((FIXTURES / "bank_login_payload.json").read_text())
