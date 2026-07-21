# WhereHouse — voiceover script

One narrator — confident, brisk, even. Read to the **measured** beat durations the capture writes to
`timings.json`; every line below is sized to ~1.9 words per second of its window, so the pace is
uniform — moving forward, never draggy, never rushed. English is the submission language and the
primary track; a Russian dub follows. Numbers are spelled the way they should be *said*.

Total spoken ≈ 310 words ≈ 2:45 of even narration across a ~2:55 cut.

---

## English (primary)

**1 · Cold open**
> Where should you open a bakery in Berlin? Watch the answer draw itself.

**2 · The map assembles**
> No wall of text. A Trigger-dot-dev agent calls ClickHouse, tool by tool, and every result paints
> itself onto the map — rivals, an opportunity surface, the three best sites, a real ten-minute walk.
> The model never touches the geometry; it only says what the map cannot.

**3 · Why this pick**
> The top site is Lichtenrade — a dense residential edge with no bakery near it. The name is real
> boundary geometry. The numbers are the ones the score ranked on. And that fourteen-thousand-person
> walk was measured by Valhalla, on the actual streets. Not guessed.

**4 · Not a calculator — a consultant** ★
> But is that the only answer? No. This isn't a calculator — it's a consultant. Ask for the biggest
> markets instead, and the pins jump to the densest, most contested blocks in the city.

**5 · Where NOT to open**
> Ask where NOT to open, and it flags the saturated turf — sixty-plus bakeries already packed around
> one block. A good consultant rules places out, too.

**6 · Down to one neighbourhood**
> Or narrow the whole question to one neighbourhood — the six best spots inside Neukölln alone, each
> named from real geometry, none of them invented. Local advice, from the same live data.

**7 · Scale**
> And it scales. Every food-and-drink venue in Berlin — thousands of points, too big for the chat
> stream's one-megabyte cap. So it never enters it: it lands in ClickHouse, read straight from the
> browser.

**8 · OLTP × OLAP**
> Save a site — it lands in Postgres, and change-data-capture streams it into ClickHouse, re-scored
> against seventy-five million live points.

**9 · The stunt**
> One last thing — there's no web server. The entire app is a row in ClickHouse. Every file, a row you
> can query.

**10 · The close**
> Ask a question, get a live map — not a wall of text. A consultant you can argue with, drawn from
> millions of points. That's WhereHouse.

---

## Русский (вариант для дубляжа)

**1 · Холодное открытие**
> Где открыть пекарню в Берлине? Смотрите, как ответ рисует себя сам.

**2 · Карта собирается сама**
> Никакой стены текста. Агент на Trigger.dev вызывает ClickHouse, инструмент за инструментом — и
> каждый результат сам ложится на карту: конкуренты, поверхность возможностей, три лучших места,
> реальная десятиминутная прогулка. Модель не трогает геометрию — она лишь говорит то, чего карта
> сказать не может.

**3 · Почему это место**
> Лучшее место — Лихтенраде: плотный жилой край, где рядом нет ни одной пекарни. Название — из
> настоящей геометрии границ. Цифры — те, по которым считался рейтинг. А охват в четырнадцать тысяч
> человек измерил Valhalla по реальным улицам. Не выдумал.

**4 · Не калькулятор — консультант** ★
> Но это единственный ответ? Нет. Это не калькулятор — это консультант. Попросите крупнейшие рынки —
> и точки прыгают в самые плотные, самые конкурентные кварталы города.

**5 · Куда НЕ соваться**
> Спросите, где НЕ открывать — и он подсветит насыщенные зоны: шестьдесят с лишним пекарен уже вокруг
> одного квартала. Хороший консультант умеет и отговаривать.

**6 · До одного района**
> Или сузьте вопрос до одного района — шесть лучших мест в одном Нойкёльне, каждое с настоящим
> названием, ничего выдуманного. Локальный совет — на тех же живых данных.

**7 · Масштаб**
> И это масштабируется. Все точки еды и напитков Берлина — тысячи объектов, слишком много для лимита
> чат-потока в один мегабайт. Поэтому туда они и не попадают: они в ClickHouse, браузер читает их
> прямо из базы.

**8 · OLTP × OLAP**
> Сохраняете место — оно уходит в Postgres. Через секунды CDC стримит его в ClickHouse и заново
> оценивает против семидесяти пяти миллионов живых точек. Ваши данные — против всего рынка, одним
> запросом.

**9 · Трюк**
> И напоследок: веб-сервера здесь нет. Всё приложение — строка в ClickHouse. Каждый файл — строка,
> которую можно запросить.

**10 · Финал**
> Задаёте вопрос — получаете живую карту, а не стену текста. Консультант, с которым можно спорить,
> нарисованный из миллионов точек. Это WhereHouse.

---

## Submission text (for the form, not the voice)

- **Title (≤100):** WhereHouse — a site-selection consultant that answers with a live map, not an essay
- **Tagline (≤160):** A Trigger.dev agent you can interrogate — biggest markets, places to avoid, one
  neighbourhood at a time — drawn live from 75M points in ClickHouse, which is also the web server.
- **One-liner on ClickHouse:** primary DB and geospatial engine — H3 scoring, GeoJSON built in SQL, a
  Dictionary UDF, an incremental materialized view, a CDC target, and the web server itself.
- **One-liner on Trigger.dev:** `chat.agent()` streams `data-map` parts with stable ids that update in
  place, so the map fills progressively; the ranking tool re-ranks under strategy / worst / district
  lenses, so the agent argues, not just answers.
