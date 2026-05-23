# UdpSqliteWeb

UDP-сервер для приёма данных и сохранения в SQLite с веб-API для запросов.

## Запуск

```bash
cd UdpSqliteWeb
dotnet run
```

## Структура проекта

```
UdpSqliteWeb/
├── ByteParser.cs         # Парсинг байтов в float с учётом порядка байт
├── DatabaseService.cs    # Работа с SQLite: создание таблиц, триггеров, запросы
├── Program.cs            # Точка входа, API эндпоинты, CORS
├── Settings.cs           # Классы конфигурации
├── UdpListenerService.cs # Фоновый сервис UDP-слушателя
├── UdpSqliteWeb.csproj   # Файл проекта
├── appsettings.json      # Конфигурация
└── wwwroot/              # Статические файлы
```

## API Эндпоинты

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/schema` | Схема БД: таблицы, колонки, заголовки |
| GET | `/api/history?id=1&from=...&to=...&step=1` | История из таблицы сырых данных |
| GET | `/api/statistics?table=AvgData&id=1&from=...&to=...` | Данные из указанной таблицы |

### Параметры запросов

- `id` — номер колонки (1, 2, 3...)
- `from`, `to` — временной диапазон (формат: `yyyy-MM-dd HH:mm:ss`)
- `step` — шаг выборки (каждую N-ю запись)
- `table` — имя таблицы из конфига

### Пример ответа `/api/schema`

```json
{
  "tables": ["RawData", "AvgData", "WorkTime"],
  "rawDataTable": "RawData",
  "columnCount": 10,
  "columns": [
    { "id": 1, "name": "col1", "header": "Температура" },
    { "id": 2, "name": "col2", "header": "Давление" }
  ],
  "retentionDays": 3
}
```

### Пример ответа `/api/history`

```json
[
  { "t": "2024-01-15 14:30:00", "v": 25.5 },
  { "t": "2024-01-15 14:32:00", "v": 26.1 }
]
```

## Конфигурация (appsettings.json)

### UdpSettings

| Параметр | Описание | По умолчанию |
|----------|----------|--------------|
| `Port` | UDP-порт для приёма данных | 3310 |
| `DataType` | Тип данных | float |
| `ByteOrder` | Порядок байт: ABCD, DCBA, CDAB, BADC | ABCD |
| `EnableInfoLogging` | Логировать каждую запись | false |

### DatabaseSettings

| Параметр | Описание | По умолчанию |
|----------|----------|--------------|
| `FileName` | Имя файла БД | data2.db |
| `Tables` | Список таблиц | ["RawData", "AvgData", "WorkTime"] |
| `ColumnCount` | Количество колонок | 10 |
| `Headers` | Заголовки для фронтенда | [] |
| `RetentionDays` | Срок хранения сырых данных | 3 |

### TriggerSettings

| Параметр | Описание | По умолчанию |
|----------|----------|--------------|
| `Enabled` | Включить триггер | true |
| `IntervalHours` | Интервал агрегации | 12 |
| `Threshold` | Порог фильтрации (значение > threshold) | 0.9 |
| `TimezoneShift` | Сдвиг часового пояса для триггера | -5 |

## Таблицы

| Индекс | Назначение |
|--------|------------|
| `Tables[0]` | Сырые данные (UDP → INSERT) |
| `Tables[1]` | Средние значения (AVG) |
| `Tables[2]` | Время работы (COUNT) |

## Триггер

При INSERT в таблицу сырых данных каждые N часов:
1. Вычисляет среднее значение (AVG) для колонок где значение > threshold
2. Подсчитывает секунды работы (COUNT * 2)
3. Удаляет сырые данные старше N дней

### Отключение триггера

```json
"TriggerSettings": {
  "Enabled": false
}
```

Использовать при изменении логики триггера в коде.

## Добавление датчиков

1. Изменить `ColumnCount` в конфиге
2. Добавить заголовок в `Headers`
3. Перезапустить сервис
4. Колонки и триггер обновятся автоматически

## UDP-протокол

- Размер пакета: `ColumnCount * 4` байт
- Тип данных: float (4 байта на значение)
- Порядок байт: настраивается через `ByteOrder`

Пример для 10 колонок: 40 байт на пакет.

## Порядок байт

| Код | Описание |
|-----|----------|
| ABCD | Big-Endian (прямой) |
| DCBA | Little-Endian (обратный) |
| CDAB | Middle-Endian (перестановка слов) |
| BADC | Перестановка байт |

## Логирование

Настраивается в `appsettings.json`:

```json
"Logging": {
  "LogLevel": {
    "Default": "Information",
    "Microsoft": "Warning"
  }
}
```

Уровни: `Trace`, `Debug`, `Information`, `Warning`, `Error`, `Critical`
