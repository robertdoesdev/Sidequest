# SideQuest

> Do something with your boredom.

SideQuest is a mobile-first web app that turns spare time into small real-world challenges, skills, experiences, and stories worth having.

## Core loop

**I'm bored → get a challenge → try it → complete it → discover something I can now do.**

## Stack

- HTML
- CSS
- Vanilla JavaScript (ES modules)
- LocalStorage for prototype persistence
- No backend required for the current MVP

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
└── README.md
```

## Current prototype features

- Home / editorial landing page
- Interest onboarding
- Personalized “Picked For You” and “Something Different”
- Discover with search and filters
- Quest Roll
- I'm Bored recommendation flow
- Challenge details and pre-flight requirements
- Active quest flow
- Completion state and reflection
- Downloadable SideQuest Clear card
- Saved quests
- Showcase
- Things I Can Do Now / progress
- Local persistence

## Hackathon

Built for **Beginner’s Paradise – FirstCommit**.
=======
