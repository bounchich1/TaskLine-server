CREATE TABLE business_profiles (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  preset text,
  description text NOT NULL DEFAULT '',
  offerings text NOT NULL DEFAULT '',
  tone text NOT NULL DEFAULT 'formal' CHECK (tone IN ('formal', 'friendly')),
  rules jsonb NOT NULL DEFAULT '[]',
  glossary jsonb NOT NULL DEFAULT '[]',
  configured_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

ALTER TABLE dictionaries
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN examples text[] NOT NULL DEFAULT '{}';

ALTER TABLE organizations
  ADD COLUMN policy_url text,
  ADD COLUMN policy_version text,
  ADD COLUMN alternative_contact text,
  ADD COLUMN menu_labels jsonb NOT NULL DEFAULT '{}';

INSERT INTO business_profiles(org_id, preset)
SELECT o.id,
  CASE WHEN EXISTS (
    SELECT 1 FROM dictionaries d WHERE d.org_id = o.id AND d.dimension = 'tag' AND d.code = 'wifi_router'
  ) THEN 'telecom' END
FROM organizations o
ON CONFLICT DO NOTHING;

UPDATE dictionaries d SET description = v.description, examples = v.examples
FROM (VALUES
  ('tag', 'no_connection', 'Интернет не работает совсем: не открывается ни один сайт, индикатор связи на роутере не горит', ARRAY['Интернета нет со вчерашнего вечера', 'Роутер горит красным, ничего не открывается']::text[]),
  ('tag', 'unstable_connection', 'Связь есть, но периодически пропадает, растёт пинг, теряются пакеты, лагают игры и звонки', ARRAY['Каждые полчаса отваливается интернет', 'В играх пинг 300, раньше был 20']::text[]),
  ('tag', 'slow_speed', 'Интернет работает, но скорость ниже тарифной: медленно грузятся страницы и видео', ARRAY['По тарифу 500 Мбит, а замер показывает 40', 'Вечером не грузится видео']::text[]),
  ('tag', 'wifi_router', 'Домашняя сеть: Wi-Fi не виден или слабый, настройки и пароль роутера', ARRAY['Wi-Fi не ловит в дальней комнате', 'Как поменять пароль от Wi-Fi?']::text[]),
  ('tag', 'equipment', 'Повреждён кабель, неисправен роутер или приставка провайдера, нужна замена или ремонт', ARRAY['Перебили кабель в подъезде', 'Приставка не включается']::text[]),
  ('tag', 'billing', 'Платежи, баланс, списания, задолженность, блокировка за неуплату', ARRAY['Оплатил, а деньги не пришли на счёт', 'Почему списали больше, чем обычно?']::text[]),
  ('tag', 'tariff', 'Смена тарифа, подключение и отключение услуг, ТВ, статический IP', ARRAY['Хочу перейти на тариф подешевле', 'Как подключить ТВ?']::text[]),
  ('tag', 'connection_request', 'Новое подключение, переезд на другой адрес, проверка технической возможности', ARRAY['Можно провести интернет в частный дом?', 'Переезжаю, как перенести договор?']::text[]),
  ('tag', 'account', 'Вход в личный кабинет, восстановление пароля, данные договора', ARRAY['Не могу войти в личный кабинет']::text[]),
  ('tag', 'complaint', 'Недовольство работой сотрудников, монтажников или поддержки', ARRAY['Мастер не пришёл в назначенное время']::text[]),
  ('tag', 'other', 'Проблема понятна, но не подходит ни под одну тему', '{}'::text[]),
  ('tag', 'undefined', 'Сообщение слишком общее, чтобы понять тему', '{}'::text[]),
  ('urgency', 'critical', 'Авария у многих абонентов (дом, район), угроза безопасности, деньги или данные теряются прямо сейчас', '{}'::text[]),
  ('urgency', 'high', 'У абонента интернет не работает совсем или деньги списаны ошибочно', '{}'::text[]),
  ('urgency', 'medium', 'Работает, но хуже: низкая скорость, обрывы, потери пакетов, пинг', '{}'::text[]),
  ('urgency', 'low', 'Вопрос, консультация, заявка или отзыв — ничего не сломано', '{}'::text[]),
  ('complexity', 'low', 'Ответ из справки или одна инструкция, без диагностики', '{}'::text[]),
  ('complexity', 'medium', 'Нужна диагностика с абонентом или проверка линии, договора, оборудования', '{}'::text[]),
  ('complexity', 'high', 'Нужен выезд техника, передача инженерам или другим отделам', '{}'::text[])
) AS v(dimension, code, description, examples), business_profiles p
WHERE p.preset = 'telecom' AND d.org_id = p.org_id AND d.dimension = v.dimension AND d.code = v.code
  AND d.description = '';

UPDATE dictionaries d SET description = v.description
FROM (VALUES
  ('urgency', 'critical', 'Сбой у многих клиентов сразу, угроза безопасности, деньги или данные теряются прямо сейчас'),
  ('urgency', 'high', 'У клиента совсем не работает услуга или ошибочно списаны деньги'),
  ('urgency', 'medium', 'Работает, но с проблемами: медленно, с перебоями, с ошибками'),
  ('urgency', 'low', 'Вопрос, консультация, заявка или отзыв — ничего не сломано'),
  ('complexity', 'low', 'Ответ из справки или одна инструкция'),
  ('complexity', 'medium', 'Нужно выяснить детали у клиента или проверить его данные в системах'),
  ('complexity', 'high', 'Нужен специалист на месте, другие отделы или несколько систем'),
  ('tag', 'other', 'Обращение понятно, но не подходит ни под одну тему'),
  ('tag', 'undefined', 'Сообщение слишком общее, чтобы понять тему')
) AS v(dimension, code, description)
WHERE d.dimension = v.dimension AND d.code = v.code AND d.description = '';

UPDATE templates SET body = E'Опишите проблему текстом или отправьте файл — обращение создастся автоматически, сотрудник поддержки ответит в этом чате.\n\n«{menu_tickets}» (/tickets) — номера и статусы ваших обращений.\n«{menu_withdraw}» (/withdraw) — прекратить обработку данных и закрыть текущее обращение.', version = version + 1
WHERE code = 'help' AND body = E'Опишите проблему текстом или отправьте файл — обращение создастся автоматически, сотрудник поддержки ответит в этом чате.\n\n«Мои обращения» (/tickets) — номера и статусы ваших обращений.\n«Отозвать согласие» (/withdraw) — прекратить обработку данных и закрыть текущее обращение.';
