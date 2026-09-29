# SideQuest

> Do something with your boredom.

SideQuest is a mobile-first web app that turns spare time into small real-world challenges, skills, experiences, and stories worth having.

## The problem

When people are bored, the easiest option is often to fall into endless scrolling. SideQuest gives that spare time a different direction: a small challenge that can be completed in the real world.

## Core loop

**I'm bored → get a challenge → try it → complete it → discover something I can now do.**

## Features

* Interest onboarding
* Personalized “Picked For You” and “Something Different” quests
* Discover with search and filters
* Quest Roll for a random challenge
* “I'm Bored” recommendation flow
* Challenge details and pre-flight requirements
* Active quest flow
* Completion state and reflection
* Downloadable SideQuest Clear card
* Saved quests
* Showcase
* Things I Can Do Now / progress tracking
* Local persistence

## Technologies

* HTML
* CSS
* Vanilla JavaScript (ES modules)
* LocalStorage for prototype persistence
* No backend required for the current MVP

## Run locally

Because the app uses JavaScript modules, run it through a local server rather than opening `index.html` directly.

### Option 1 — VS Code Live Server

Open the folder in VS Code and use the Live Server extension.

### Option 2 — Python

```bash
python -m http.server 5500
```

Then open `http://localhost:5500`.

## Project structure

```text
Sidequest/
├── index.html
├── styles.css
├── app.css
├── app.js
├── data.js
├── assets/
│   ├── card-flourish.jpg
│   └── moonwalk.jpg
├── favicon/
└── README.md
```

## Credits & external resources

* Google Fonts — DM Sans and Space Grotesk
* No external APIs are required by the current MVP.

## AI usage

AI tools were used as development aids during the hackathon for brainstorming, UI/product iteration, debugging, code assistance, and reviewing implementation decisions.

The project was developed and assembled by the participant, who reviewed, tested, and adapted the code and is able to explain the implementation and technical decisions.

## Hackathon

Built for **Beginner’s Paradise – FirstCommit**.

## Development

SideQuest was developed as a rapid MVP during the hackathon. The goal was to turn the initial idea into a working, interactive prototype within the available build time.
