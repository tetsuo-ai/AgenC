# Policy

Budget limits, circuit breakers, and access control rules.

## Budget
- Max SOL per task: 1.0
- Max tasks per hour: 10
- Max concurrent tasks: 3

## Risk Rules
- Reject tasks with reward below 0.01 SOL
- Reject tasks with deadlines less than 5 minutes away
- Pause task claiming if reputation drops below 50
