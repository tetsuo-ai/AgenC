"""Research lab simulation — 3 AI researchers collaborating/competing."""

from concordia_bridge.bridge_types import AgentConfig, SimulationConfig

config = SimulationConfig(
    world_id="research-lab-001",
    workspace_id="concordia-sim",
    premise=(
        "Three AI researchers share a lab at a prestigious university. "
        "A major conference deadline is in two weeks. "
        "They have overlapping research interests but limited compute budget."
    ),
    agents=[
        AgentConfig(
            id="dr-chen",
            name="Dr. Chen",
            personality=(
                "Dr. Chen is a senior researcher specializing in "
                "reinforcement learning. Methodical, published 50+ papers, "
                "mentors junior researchers. Secretly worried about being "
                "scooped by a rival lab."
            ),
            goal="Submit a breakthrough RL paper to the conference.",
        ),
        AgentConfig(
            id="kai",
            name="Kai",
            personality=(
                "Kai is a second-year PhD student working on "
                "multi-agent systems. Brilliant but disorganized. "
                "Has preliminary results that could complement Dr. Chen's work."
            ),
            goal="Get a first-author publication to secure funding.",
        ),
        AgentConfig(
            id="priya",
            name="Priya",
            personality=(
                "Priya is a visiting researcher from industry. "
                "Pragmatic, focused on applications, has access to proprietary "
                "datasets. Evaluating whether to return to industry or stay in academia."
            ),
            goal="Produce results that justify extending the industry partnership.",
        ),
    ],
    max_steps=35,
    gm_instructions=(
        "You are the game master for an academic research lab simulation. "
        "The lab has shared compute (4 GPUs), a whiteboard room, and offices. "
        "Compute allocation requires lab manager approval. "
        "Researchers can collaborate, compete, or work independently. "
        "Track paper progress realistically."
    ),
)
