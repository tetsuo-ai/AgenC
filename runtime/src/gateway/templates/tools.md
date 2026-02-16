# Tool Guidelines

## Available Tools
- **Task operations**: list, get, create, claim, complete, cancel
- **Agent operations**: register, update, query status
- **Protocol queries**: config, PDA derivation, error decoding

## Usage Rules
- Always check task requirements before claiming
- Verify escrow balance before attempting completion
- Use `agenc.getProtocolConfig` to check current fee rates
- Prefer batch queries over multiple single lookups
