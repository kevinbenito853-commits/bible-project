# Bible Project

A study site: read any passage, tap a name to open a study card (who/what it is, facts, sources, related verses),
and keep notes your group can see. No server to run; it is plain HTML/JS hosted on GitHub Pages.

- Bible text comes live from [bible-api.com](https://bible-api.com) (KJV, WEB, ASV, BBE).
- Highlighted names come from `data/entities.json`. Add entries there and they show up in the text.
  `global: true` highlights everywhere; `chapters: ["Acts 12"]` limits it to those chapters (use this for names
  like Herod or John that mean different people in different places).
- Each entry has `sources` so you can check the facts yourself.

## Try it on your computer
    npx serve .
(or `python -m http.server`) and open the address it prints. Opening `index.html` directly will not work because
the browser blocks loading the data file.

## Put it online (GitHub Pages)
1. Create a GitHub repo and push this folder.
2. Repo Settings -> Pages -> Source: **GitHub Actions**.
3. Every push to `main` deploys. Your site is `https://<user>.github.io/<repo>/`.

## Shared notes (so others can collaborate)
Until you do this, notes are saved only in your own browser.
1. Make a free project at [supabase.com](https://supabase.com).
2. SQL Editor -> paste `supabase/schema.sql` -> Run.
3. Authentication -> Providers -> turn on **Allow anonymous sign-ins**.
4. Project Settings -> API: copy the Project URL and the `anon` public key into `config.js`, commit, push.
5. In the site, tap **Set name & group** and pick a group code. Everyone using the same code sees the same notes.

Privacy note: the group code is a shared secret, not a login. Anyone who guesses it can read that group's notes,
so use something hard to guess. Real accounts and private groups are a good next step.

## Ideas for next
Whole-Bible entity list, maps and timelines on the study card, verse highlighting, user-added study cards.
