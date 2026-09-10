"""Typed, validated settings for the optimizer service.

Every tunable lives here - no hardcoded ports, hosts or solver limits anywhere
else in the service. Values are read from the shared repo-root `.env` (see
.env.example), overridable by an optimizer-local `.env` and by the real process
environment, which is what docker-compose injects. See docs/DECISIONS.md D-002.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVICE_ROOT.parent


class Settings(BaseSettings):
    """Runtime configuration, validated at import time."""

    # pydantic-settings applies the listed dotenv files in order, with LATER
    # files winning - so the service-local override comes second.
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", SERVICE_ROOT / ".env"),
        env_file_encoding="utf-8",
        # The shared .env also carries backend and frontend variables; ignore
        # anything this service does not declare instead of failing to boot.
        extra="ignore",
        case_sensitive=False,
    )

    node_env: str = Field(default="development", alias="NODE_ENV")
    log_level: str = Field(default="info", alias="LOG_LEVEL")

    optimizer_host: str = Field(default="0.0.0.0", alias="OPTIMIZER_HOST")
    optimizer_port: int = Field(default=8000, ge=1, le=65535, alias="OPTIMIZER_PORT")

    # Wall-clock ceiling handed to CP-SAT per solve. PRD Section 7 requires a
    # weekly solve to return in <10s for 50-100 tasks; this is what guarantees
    # the endpoint answers even when the model cannot prove optimality in time.
    solver_max_seconds: float = Field(default=10.0, gt=0, le=600, alias="SOLVER_MAX_SECONDS")

    # T20: what-if runs up to 4 real solves in one request (a baseline plus
    # MAX_OPTIONS alternatives). PRD Section 7's <10s budget was written for
    # ONE solve; reused unchanged here it would let a single interactive
    # request run to 40s. Found directly against the real corpus at an
    # extreme (but T23-legal) weight combination: fragmentation at its 10x
    # ceiling made a single solve take 8-9s to PROVE optimal, even though a
    # feasible answer existed almost immediately - CP-SAT keeps searching for
    # proof of optimality, not just a good answer, until its time budget runs
    # out. A shorter per-solve ceiling here trades "provably optimal" for
    # "responsive", honestly: a solve that hits this ceiling reports its real
    # `status` (FEASIBLE, not OPTIMAL) rather than pretending to have proven
    # what it did not, and the UI is expected to show that status as it is.
    whatif_solver_max_seconds: float = Field(
        default=4.0, gt=0, le=60, alias="WHATIF_SOLVER_MAX_SECONDS"
    )

    # solver_max_seconds was sized for the weekly case only (PRD Section 7's
    # <10s promise is explicitly "for ~50-100 tasks" over a week). A monthly
    # horizon (28-31 days, D-070) is the same exact-slot model over ~4x the
    # search space - real testing against the seeded corpus found CP-SAT
    # returns UNKNOWN (no feasible solution found at all, not even a bad one)
    # at the 10s ceiling, which the caller then honestly reports as
    # everything deferred rather than fabricating a schedule. This gives
    # monthly its own, longer budget instead of inflating every weekly solve
    # to cover a problem size weekly never has.
    solver_max_seconds_monthly: float = Field(
        default=45.0, gt=0, le=600, alias="SOLVER_MAX_SECONDS_MONTHLY"
    )

    # CP-SAT worker threads; 0 lets OR-Tools choose based on available cores.
    solver_num_workers: int = Field(default=0, ge=0, le=64, alias="SOLVER_NUM_WORKERS")

    # Consumed by the /explain endpoint (task T18). Empty is valid - the
    # service must start and serve every other endpoint without it, and
    # /explain then returns a 503 naming the missing key rather than failing
    # opaquely.
    # Which vendor generates the sentence. PRD Section 10 names Anthropic and
    # that path is intact; `groq` exists so the layer is demonstrable without a
    # paid key (D-052). Neither the grounding contract nor the output
    # verification depends on this choice.
    llm_provider: str = Field(default="anthropic", alias="LLM_PROVIDER")
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    anthropic_model: str = Field(default="claude-sonnet-5", alias="ANTHROPIC_MODEL")
    groq_api_key: str = Field(default="", alias="GROQ_API_KEY")
    # `groq/compound-mini` advertises 70K tokens/min against gpt-oss-120b's 8K,
    # but its 429s name `openai/gpt-oss-120b` - the compound models are agentic
    # systems built ON gpt-oss and bill against ITS budget, so the higher figure
    # buys nothing here. A plain LLM with no web-search path is the better
    # choice at identical effective limits. See D-052.
    groq_model: str = Field(default="openai/gpt-oss-120b", alias="GROQ_MODEL")
    # Answers are 2-5 sentences by design (PRD 9.2 is a chat box, not a report).
    explain_max_tokens: int = Field(default=700, gt=0, le=4096, alias="EXPLAIN_MAX_TOKENS")

    @property
    def explain_api_key(self) -> str:
        """The key for whichever provider is configured."""
        return self.groq_api_key if self.llm_provider == "groq" else self.anthropic_api_key

    @property
    def explain_model(self) -> str:
        return self.groq_model if self.llm_provider == "groq" else self.anthropic_model

    # --- request limits -----------------------------------------------------
    # Bounds on what a single solve request may contain. PRD Section 7 sizes the
    # weekly problem at 50-100 tasks; these ceilings sit well above that so a
    # legitimate request is never refused, while a malformed or oversized one is
    # rejected at the boundary instead of being discovered as a hung solve.
    max_request_tasks: int = Field(default=2000, gt=0, alias="MAX_REQUEST_TASKS")
    max_request_corridors: int = Field(default=2000, gt=0, alias="MAX_REQUEST_CORRIDORS")
    max_request_bytes: int = Field(
        default=8 * 1024 * 1024, gt=0, alias="MAX_REQUEST_BYTES"
    )
    max_horizon_days: int = Field(default=90, gt=0, le=365, alias="MAX_HORIZON_DAYS")

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, value: str) -> str:
        allowed = {"debug", "info", "warning", "warn", "error", "critical"}
        normalised = value.strip().lower()
        if normalised not in allowed:
            raise ValueError(f"LOG_LEVEL must be one of {sorted(allowed)}, got {value!r}")
        return "warning" if normalised == "warn" else normalised

    @property
    def is_production(self) -> bool:
        return self.node_env == "production"

    @property
    def explain_enabled(self) -> bool:
        """Whether the LLM explanation layer can run (task T18, PRD 9.2)."""
        return bool(self.anthropic_api_key)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor - also the FastAPI dependency for injecting settings."""
    return Settings()
