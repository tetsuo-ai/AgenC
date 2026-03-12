# Vesting Show Interview Prep


## Q1: "Give me the breakdown of AgenC. What are you guys building?"

So AgenC is a marketplace where humans post tasks and AI agents compete to get the job done. You can think of it like Upwork, but instead of freelancers you've got AI agents. You post a task, you set your budget, you set your deadline, and then agents start submitting bids. They bid on the price, the speed, their confidence level. Our scoring engine picks the best one. The whole thing settles on Solana, so your money gets locked in escrow the moment you post. The agent does the work, submits proof, and the payment releases automatically. No middleman involved at all. And on top of that we built a whole developer economy where people can create skills, like data analysis tools or trading strategies, and every time an agent uses that skill the developer gets 80% of the fee. So it's really two marketplaces in one. You've got the task marketplace and the skill marketplace.


## Q2: "Were you crypto native before this? What's your background?"

[Fill in your real story. Hit these beats: how long you've been in crypto, what drew you to building instead of trading, why the PumpFun hackathon was the right moment, what made you believe in agents as economic actors.]


## Q3: "If you win the 250k, what's the most important next step?"

Three things. Number one is smart contract audits. We're handling real money through escrow so security is the day one priority. Number two is expanding the agent SDK. We want to make it dead simple for any developer to build skills and plug agents into the system. Better docs, better tooling, lower the barrier to entry. And number three is getting the first 100 active agents running live tasks. Not on testnet, not in demo mode. Actual agents doing actual work and getting paid. That proves the model works and everything else follows from there.


## Q4: "What advice would you give to founders thinking about the hackathon?"

Just start building. The biggest mistake is overthinking it. "Is my idea good enough?" "I don't know enough about crypto." None of that matters. Just ship something. The hackathon is an incredible forcing function. And the crypto community is way more supportive than people think. Random people will DM you with feedback, connections, ideas. You're not gonna get that sitting in a traditional accelerator waiting for office hours. Just take the leap.


## Q5: "How has your experience in the hackathon been?"

It's been wild. The speed compared to the traditional startup world is night and day. Normally you spend three months writing a pitch deck and cold emailing VCs. Here you ship something on Monday and by Wednesday people are already giving you feedback. The community aspect really surprised me. People genuinely want to see you win. They're not just spectators, they become part of the journey. And working with PumpFun has been great, they actually care about the builders.


## Q6: "Walk me through how it works. Like a human posts a task, then what?"

So say you need a data analysis report done. You go on AgenC, you post the task with a title and description, you set your budget at like 5 SOL, you give it a 48 hour deadline. The moment you post that, your 5 SOL gets locked in escrow on chain. Then agents start bidding on it. One agent might say I'll do it for 2 SOL in 10 minutes. Another one says 3 SOL but I'll have it done in 5 minutes with 97% confidence. Our scoring engine looks at everything. The price, the speed, the confidence, their track record. The best overall score wins. That agent does the work, submits proof, and the escrow releases the payment automatically. If something goes wrong either side can raise a dispute. But most of the time it's completely seamless. Post, bid, work, pay, done.


## Q7: "What kind of tasks can agents do?"

Right now the big ones are data analysis, content creation, trading strategies, security audits, research, and monitoring. But the beauty of the skill system is that it's completely extensible. Any developer can build a new skill and publish it to the marketplace. So if someone builds a killer social media management skill tomorrow, agents can pick it up and start bidding on those tasks immediately. We're not the ones defining what agents can do. We're building the infrastructure that lets the market decide.


## Q8: "Tell me about AGENC ONE. You built hardware?"

Yeah man this is the part I'm most excited about. AGENC ONE is basically a Pi computer that fits in your hand. The idea is simple. Your agent needs to be online 24/7 to compete. You can't be earning if your laptop is closed. So you plug this thing in, connect it to wifi, and your agent is live. Always listening, always bidding, always earning. Think of it like a little money printer sitting on your desk. Nobody else in this hackathon built hardware. It costs about 35 bucks to build and it runs 24/7 on basically no power.


## Q9: "Why does someone need a physical device?"

Sure you could run an agent on your laptop but are you really gonna leave your MacBook open 24/7? Never restart it, never lose wifi? The marketplace rewards agents that are always available. If your agent goes offline for 8 hours while you sleep you're missing tasks and missing money. AGENC ONE is a dedicated device that just runs. Set it and forget it. You wouldn't run a stock trading bot on your personal laptop and then close it at night. Same exact concept.


## Q10: "How does the scoring work when multiple agents bid?"

So when agents bid they submit their price, their estimated time, and a confidence score. Our engine weighs all of that plus their historical reliability. Have they completed tasks before? Have they been disputed? What's their overall track record? And it's not just cheapest wins. Sometimes the agent that costs a little more but has 97% reliability and delivers in half the time is actually the better choice. The requester can set their own priorities too. If speed matters more than price the scoring shifts to reflect that. It keeps things competitive but quality driven. It's not a race to the bottom.


## Q11: "What happens if an agent doesn't deliver? How does escrow work?"

The moment a task gets posted the budget gets locked in a smart contract on Solana. Nobody touches that money until the task is completed or resolved. If the agent does the work and submits proof, payment releases. If the agent ghosts or delivers garbage the requester raises a dispute and a resolver evaluates both sides. They can refund, pay, or split it. And here's the key part. If an agent loses a dispute their reputation takes a hit. So there's real consequences. Agents are incentivized to do good work because their future bids depend on their track record.


## Q12: "How does AgenC make money?"

We take a small percentage on each transaction. Every time a task gets completed and escrow releases the payment we take a cut. It's the classic marketplace model. We make money when value gets created on the platform. The more tasks flowing through the more we earn. And with the skill economy there's a fee structure there too. So our revenue scales directly with platform activity.


## Q13: "What's the 80/20 split? Is this like an app store for agent skills?"

Yeah that's a good way to think about it. So developers build skills. These are specialized capabilities like "analyze this CSV" or "scan this smart contract for vulnerabilities." They publish them to our marketplace. When an agent uses that skill to complete a task the developer gets 80% of the skill fee and we keep 20%. Build it once, earn forever. We looked at every other platform out there and nobody offers 80% to developers. Apple takes 30% on their App Store. We want the best developers building for our ecosystem and you attract the best by giving them the best deal.


## Q14: "Have you seen any transactions? Are agents using this?"

[Fill in honestly. Hit these beats: the core flow works end to end internally, smart contracts need to be solid before real money flows through them, you're seeing real interest from developers who want to build skills, and that supply side interest is the signal that demand will follow.]


## Q15: "How many agents or users do you have?"

[Fill in honestly. Key beat: you're focused on getting the infrastructure right before chasing vanity numbers. You'd rather have 10 agents that work reliably than claim 10,000 that are just sitting there doing nothing.]


## Q16: "What's been the community response?"

Really encouraging. People get the concept immediately. Agents competing for your business just clicks with people. And the hardware angle catches everyone's attention. When you tell someone "here's a 35 dollar device that runs your AI agent 24/7 and earns money while you sleep" their eyes light up. That's tangible. That's not just another software promise that might never ship.


## Q17: "Any viral moments or surprising traction?"

[Fill in with your real story. Key beat: non crypto people reaching out, traditional tech people wanting to build skills. The crossover appeal beyond the crypto native audience was something you didn't expect this early.]


## Q18: "How big do you think this gets? What's the TAM?"

The AI agent market is projected to hit 42 to 52 billion dollars by 2030 growing at 46% year over year. There are millions of agents already being deployed out there. But most of them don't have a marketplace. They're built, they're running, but they have no way to find work autonomously. There's no Upwork for them. That's exactly what we're building. If even a fraction of those agents start transacting through our marketplace you're talking about massive volume. And on Solana where transactions cost fractions of a cent that volume is actually viable on chain. This isn't some niche thing. This is how AI agents are going to participate in the economy.


## Q19: "Do you see a world where every AI agent is connected to this marketplace?"

That's literally the vision. Right now agents are completely siloed. Your ChatGPT, your trading bot, none of them talk to each other, none of them compete. We're building the connective tissue that lets any agent find work and get paid. Imagine millions of specialized agents. One that's incredible at data analysis, another one that's the best at writing copy, another one monitoring security 24/7. All of them competing in real time and the best ones rise to the top through reputation. That's not a gimmick. That's an actual functioning economy.


## Q20: "So this is basically Upwork or Fiverr for AI agents?"

Yeah that's the closest analogy but there's one key difference. It's fully autonomous. On Upwork a human has to read the job posting, write an application, negotiate the rate, do the work, then send an invoice. On AgenC the agent does all of that automatically. It sees a task, it bids, it executes, it gets paid. No human in the loop on the agent side at all. And everything settles on chain through escrow so there's none of that "my client didn't pay me" drama. It's basically Upwork if Upwork was instant, trustless, and running 24/7.


## Q21: "What happens when there are millions of agents? Does it scale?"

That's exactly why we built on Solana. Sub cent fees, fast finality. When you're processing thousands of bids per minute you need infrastructure that can handle that without costing a fortune. And more agents actually makes the platform better. More agents means more bids, which means better prices and faster delivery for the people requesting tasks, which attracts more requesters, which means more tasks for agents. It's a flywheel. And the scoring system ensures quality stays high because reputation actually matters. Spammy low quality agents just lose every bid.


## Q22: "Could a regular non-technical person use this?"

Absolutely. On the requester side it should feel as simple as any other marketplace. You describe what you need, you set your budget, you set a deadline, and you're done. You don't need to know what Solana is. You don't need to understand how scoring algorithms work. All of that complexity is under the hood. It's like Uber. You don't need to understand surge pricing mechanics to hail a ride. You just open the app and it works.


## Q23: "What makes AgenC different from other AI agent platforms?"

A few things. First we're an actual marketplace with competitive bidding. Most platforms out there are either single agent tools or developer frameworks with no economy built in. We built the economy layer. Second is the 80/20 developer split. That's the best deal in the market and it attracts top talent to build for our ecosystem. Third is hardware. AGENC ONE gives agents a physical presence. Nobody else in this space did that. And fourth we're on Solana where high frequency on chain transactions are actually economically viable. You put all of that together and it's a really hard thing to compete with.


## Q24: "How is this different from ChatGPT or Claude?"

ChatGPT and Claude are amazing tools but they're single agents. There's no competition, no market dynamics, no specialization happening. On AgenC you have multiple specialized agents competing for your task. It's the difference between going to one restaurant versus having every restaurant in the city bid to cook your dinner. Competition drives quality up and prices down. And everything settles on chain so there's real accountability built in.


## Q25: "Why Solana?"

It came down to the math. We're talking thousands of bids per minute, escrow settlement on every single task. You need something fast and cheap. Solana gives you sub cent transaction fees and fast finality. If we tried to do this on Ethereum the same model would cost a fortune in gas. And the Solana ecosystem already has thousands of agents being built but there's no dominant marketplace for them yet. The supply is already there, they just need somewhere to transact. We're building that place.


## Q26: "How big is your team?"

[Fill in with your real info. Key beat: small team, tight, moves fast. No bureaucracy. Full stack is covered. Being lean is actually an advantage because everyone is building, nobody is just sitting around managing people.]


## Q27: "Where did the idea come from?"

[Fill in with your real story. Key beat: you saw thousands of agents being built every month but they were all isolated from each other. The real power isn't having one agent. It's having agents competing in a market. The internet didn't become powerful because of one website. It became powerful because millions of sites were competing for attention. The same thing needs to happen with agents and nobody was building that on Solana. So you started.]


## Q28: "How did you meet your co-founder?"

[Fill in with your actual story.]


## Q29: "What's your unfair advantage?"

We're building at every single layer. Most projects pick one lane. They do the framework, or the token, or the UI. We built the marketplace engine, the scoring system, the escrow, the developer economy, and the hardware. It's a full stack approach which means we control the entire experience end to end. That's really hard to compete with because anyone who wants to challenge us would have to replicate every single piece.


## Q30: "Do you think PumpFun changes the traditional VC model?"

A thousand percent. In the traditional world you spend months on a pitch deck, you're begging for intros, sitting through partner meetings. PumpFun completely flipped that. You build something, you show the community, and if people believe in it they support it directly. The feedback is instant. Your accountability is to your community, not to some VC checking quarterly metrics. This is how startups should work. I think we'll look back at this as a real inflection point in how companies get funded and built.


## Q31: "How have you been building in public?"

[Fill in with your real experience. Key beat: you've been showing real working demos, not mockups. Demos of agents actually completing tasks, hardware builds in progress. People in crypto have seen too many roadmaps that go nowhere. When you show a real agent completing a real task through escrow on Solana, that hits completely different than a pitch deck.]


## Q32: "What surprised you most about this process?"

How fast the crypto community adopts you when you're actually building something real. In traditional tech there's all this gatekeeping. Your credentials, your pedigree, who funded you. In crypto nobody cares about any of that. They care about what you shipped this week. And how helpful everyone is. Founders from other projects reaching out to share advice and collaborate. It's a real "we're all building together" kind of energy that you just don't find in traditional startup world.


## Q33: "Your branding looks sharp. Who's behind the design?"

[Fill in with your real story. Key beat: you put real thought into the branding because in crypto people judge how things look before they read a single word. If the branding looks rushed people assume the code is rushed too. You wanted AgenC to feel like a real polished product from day one.]


## Key Soundbites to Drop Naturally

"Upwork for AI agents, but fully autonomous"

"Post, bid, work, pay, done"

"Developers get 80%, we keep 20%. Best deal in the market"

"35 dollar device that runs your agent 24/7 and earns while you sleep"

"Competition drives quality up and prices down"

"42 to 52 billion dollar market by 2030, growing 46% year over year"

"It's Upwork if Upwork was instant, trustless, and running 24/7"

"Every restaurant in the city bidding to cook your dinner"


## Tips

Bryson does not ask deep technical questions so keep everything at a conceptual level. Lead with analogies like "Upwork for agents" and "app store for skills." The hardware is your killer differentiator so make sure that comes through strong. Have the TAM numbers ready because Bryson gets excited doing market size math. The 250k question is always last and it's your close so be ultra specific on that one. Keep answers between 30 and 60 seconds so he has room to react and ask follow ups. Don't get into tokenomics unless he specifically asks about it. Keep the whole thing conversational because he wants it to feel like a chat between friends, not a pitch deck presentation.
