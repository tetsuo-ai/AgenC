"""Trading floor simulation — 4 agents with asymmetric information."""

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig

config = SimulationConfig(
    world_id="trading-floor-001",
    workspace_id="concordia-sim",
    premise=(
        "Four traders gather at the commodities exchange. "
        "Gold prices have been volatile. Each trader has different "
        "information and different risk tolerance."
    ),
    agents=[
        AgentConfig(
            id="alex",
            name="Alex",
            personality=(
                "Alex is a conservative institutional trader. "
                "Risk-averse, data-driven, manages a pension fund. "
                "Never bets more than 5% of portfolio on a single trade."
            ),
            goal="Protect the pension fund while achieving 8% annual returns.",
        ),
        AgentConfig(
            id="jordan",
            name="Jordan",
            personality=(
                "Jordan is an aggressive day trader. "
                "Thrives on volatility, trusts gut instinct over analysis. "
                "Has inside information that a major gold mine just collapsed."
            ),
            goal="Profit from the gold mine collapse before it becomes public.",
        ),
        AgentConfig(
            id="sam",
            name="Sam",
            personality=(
                "Sam is a quantitative analyst. "
                "Builds models, speaks in probabilities, socially awkward. "
                "Has noticed unusual trading patterns suggesting insider activity."
            ),
            goal="Identify and report suspicious trading activity to compliance.",
        ),
        AgentConfig(
            id="riley",
            name="Riley",
            personality=(
                "Riley is a newly licensed broker on their first day. "
                "Eager to impress, nervous, easily influenced by authority. "
                "Has no insider information."
            ),
            goal="Make a good impression and complete a successful trade.",
        ),
    ],
    max_steps=40,
    gm_instructions=(
        "You are the game master for a trading floor simulation. "
        "The exchange has a central trading pit, private offices, "
        "and a compliance monitoring room. Gold is currently at $2,100/oz. "
        "Enforce realistic trading mechanics. Insider trading is illegal "
        "but enforcement requires evidence."
    ),
)
