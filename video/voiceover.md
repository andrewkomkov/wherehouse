# WhereHouse — voiceover script

One narrator, calm and confident. Read to the **measured** beat durations the capture writes
to `timings.json` — the targets below are guides. English is the submission language and the
primary track; a Russian version follows for flexibility. Numbers are spelled the way they
should be *said*, not written.

Total spoken ≈ 250 words ≈ 2:40 at a relaxed pace, leaving air between beats.

---

## English (primary)

**1 · Cold open (0:00–0:12)**
> Where should you open a bakery in Berlin? It's a spatial question — so the answer shouldn't be
> a paragraph. Watch.

**2 · The map assembles (0:12–0:38)**
> No wall of text. A Trigger-dot-dev agent calls ClickHouse, tool by tool, and each result draws
> itself onto the map — in place. Competitors. An opportunity surface. The three best sites. A
> real walking catchment. The model never sees the geometry; it only gets to say what the map
> can't.

**3 · Why this pick (0:38–1:05)**
> The winner is Lichtenrade — a dense residential edge with no bakery nearby. The name comes from
> real boundary geometry. The numbers are the ones the score ranked on. And the fourteen-
> thousand-person walk reach? Measured by Valhalla against the actual street network — not
> guessed.

**4 · The agent operates the UI (1:05–1:30)**
> You don't just read the answer — you argue with it. Ask it to weight walkability higher, and
> the agent moves the sliders itself. The surface re-scores in the browser, instantly, on the
> same numbers ClickHouse already sent.

**5 · Scale (1:30–1:52)**
> And it scales. Every food-and-drink venue in Berlin — thousands of points. Too large for the
> chat stream's one-megabyte limit, so it never touches it. It lands in ClickHouse, and the
> browser reads it straight from the database.

**6 · OLTP × OLAP (1:52–2:18)**
> Save a site, and it goes to Postgres. Seconds later, change-data-capture replicates it into
> ClickHouse — where it's re-scored against seventy-five million live points. Your own data,
> joined against the whole market, in one query.

**7 · The stunt (2:18–2:32)**
> One last thing — there is no web server. This entire app is a row in ClickHouse. Every file, a
> row you can query.

**8 · The close (2:32–2:55)**
> The agent runs on Trigger-dot-dev's cloud. Ask a question, get a map — not a wall of text.
> That's WhereHouse.

---

## Русский (вариант для дубляжа)

**1 · Холодное открытие**
> Где открыть пекарню в Берлине? Это вопрос про место — и ответом не должен быть абзац текста.
> Смотрите.

**2 · Карта собирается сама**
> Никакой стены текста. Агент на Trigger.dev вызывает ClickHouse, инструмент за инструментом — и
> каждый результат сам дорисовывается на карту. Конкуренты. Поверхность возможностей. Три лучших
> места. Реальная зона пешей доступности. Модель не видит геометрию — ей позволено сказать лишь
> то, чего карта показать не может.

**3 · Почему это место**
> Победитель — Лихтенраде: плотный жилой край, где рядом нет ни одной пекарни. Название взято из
> настоящей геометрии границ. Цифры — те самые, по которым считался рейтинг. А охват в четырнадцать
> тысяч человек за десять минут пешком измерил Valhalla по реальной уличной сети. Не выдумал.

**4 · Агент управляет интерфейсом**
> Ответ можно не просто читать — с ним можно спорить. Попросите поднять вес пешей доступности — и
> агент сам двигает ползунки. Поверхность пересчитывается прямо в браузере, мгновенно, на тех же
> числах, что уже прислал ClickHouse.

**5 · Масштаб**
> И это масштабируется. Все точки еды и напитков Берлина — тысячи объектов. Слишком много для
> лимита чат-потока в один мегабайт — поэтому он туда и не попадает. Данные ложатся в ClickHouse,
> а браузер читает их прямо из базы.

**6 · OLTP × OLAP**
> Сохраняете место — оно уходит в Postgres. Через секунды CDC реплицирует его в ClickHouse, где
> оно заново оценивается против семидесяти пяти миллионов живых точек. Ваши данные — против всего
> рынка, одним запросом.

**7 · Трюк**
> И напоследок: веб-сервера здесь нет. Всё приложение — это строка в ClickHouse. Каждый файл —
> строка, которую можно запросить.

**8 · Финал**
> Агент работает в облаке Trigger.dev. Задаёте вопрос — получаете карту. Не стену текста. Это
> WhereHouse.

---

## Submission text (for the form, not the voice)

- **Title (≤100):** WhereHouse — ask where to open your business, get a map, not an essay
- **Tagline (≤160):** A Trigger.dev agent answers site-selection questions as a live map that
  assembles itself from 75M points in ClickHouse — the database is also the web server.
- **One-liner on ClickHouse:** primary DB, geospatial engine (H3 scoring, GeoJSON built in SQL),
  a Dictionary UDF, an incremental materialized view, CDC target, and the web server itself.
- **One-liner on Trigger.dev:** `chat.agent()` streams `data-map` parts with stable ids that
  update in place, so the map fills progressively; 13 tools, deployed to managed prod.
