using Microsoft.Data.Sqlite;
using System.Globalization;

public class DatabaseService
{
    private readonly string _connectionString;
    private readonly List<string> _tables;
    private readonly int _columnCount;
    private readonly string _rawDataTable;
    private readonly TriggerSettings _triggerSettings;
    private readonly List<string> _headers;
    private readonly int _retentionDays;
    private readonly ILogger<DatabaseService> _logger;

    public DatabaseService(IConfiguration config, ILogger<DatabaseService> logger)
    {
        _logger = logger;
        var dbSettings = config.GetSection("DatabaseSettings");
        _connectionString = $"Data Source={dbSettings["FileName"]}";
        _tables = dbSettings.GetSection("Tables").Get<List<string>>() ?? new();
        _columnCount = dbSettings.GetValue<int>("ColumnCount");
        _rawDataTable = _tables.FirstOrDefault() ?? "RawData";
        _triggerSettings = config.GetSection("TriggerSettings").Get<TriggerSettings>() ?? new();
        _headers = dbSettings.GetSection("Headers").Get<List<string>>() ?? new();
        _retentionDays = dbSettings.GetValue<int>("RetentionDays");
        if (_retentionDays <= 0) _retentionDays = 3;
        
        InitializeTables();
        InitializeTrigger();
    }

    private void InitializeTables()
    {
        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using (var command = connection.CreateCommand())
        {
            // Включаем WAL режим
            command.CommandText = "PRAGMA journal_mode = WAL;";
            command.ExecuteNonQuery();

            // Дополнительно: оптимизируем синхронизацию с диском для максимальной скорости
            command.CommandText = "PRAGMA synchronous = NORMAL;";
            command.ExecuteNonQuery();
        }
        foreach (var tableName in _tables)
        {
            var columns = new List<string> { "timestamp TEXT" };
            for (int i = 1; i <= _columnCount; i++)
                columns.Add($"col{i} REAL");
            
            var createCmd = connection.CreateCommand();
            createCmd.CommandText = $"CREATE TABLE IF NOT EXISTS {tableName} ({string.Join(", ", columns)})";
            createCmd.ExecuteNonQuery();
            
            for (int i = 1; i <= _columnCount; i++)
            {
                try
                {
                    var alterCmd = connection.CreateCommand();
                    alterCmd.CommandText = $"ALTER TABLE {tableName} ADD COLUMN col{i} REAL";
                    alterCmd.ExecuteNonQuery();
                }
                catch { /* Колонка уже существует */ }
            }
        }
        
        _logger.LogInformation("Таблицы инициализированы: {Tables}, колонок: {Count}", 
            string.Join(", ", _tables), _columnCount);
        _logger.LogInformation("Таблица для сырых данных: {RawTable}", _rawDataTable);
    }

    private void InitializeTrigger()
    {
        if (!_triggerSettings.Enabled)
        {
            _logger.LogInformation("Триггер отключён (TriggerSettings.Enabled = false)");
            return;
        }

        if (_tables.Count < 3)
        {
            _logger.LogWarning("Недостаточно таблиц для триггера (нужно минимум 3: RawData, AvgData, WorkTime)");
            return;
        }

        var avgTable = _tables.ElementAtOrDefault(1) ?? "AvgData";
        var workTimeTable = _tables.ElementAtOrDefault(2) ?? "WorkTime";
        int interval = _triggerSettings.IntervalHours;
        double threshold = _triggerSettings.Threshold;
        int tzShift = _triggerSettings.TimezoneShift;
        int retentionDays = _retentionDays;

        var avgColumns = new List<string>();
        var workTimeColumns = new List<string>();
        var avgSelects = new List<string>();
        var workTimeSelects = new List<string>();

        for (int i = 1; i <= _columnCount; i++)
        {
            avgColumns.Add($"col{i}");
            workTimeColumns.Add($"col{i}");
            avgSelects.Add($"(SELECT AVG(col{i}) FROM {_rawDataTable} WHERE timestamp >= datetime(NEW.timestamp, '-{interval} hours') AND timestamp < NEW.timestamp AND col{i} > {threshold.ToString(CultureInfo.InvariantCulture)})");
            workTimeSelects.Add($"(SELECT COUNT(*) * 2 FROM {_rawDataTable} WHERE timestamp >= datetime(NEW.timestamp, '-{interval} hours') AND timestamp < NEW.timestamp AND col{i} > {threshold.ToString(CultureInfo.InvariantCulture)})");
        }

        string triggerSql = $@"
CREATE TRIGGER IF NOT EXISTS trigger_shift_summary
AFTER INSERT ON {_rawDataTable}
FOR EACH ROW
WHEN 
    (CAST(strftime('%H', datetime(NEW.timestamp, '{tzShift} hours')) AS INT) / {interval}) <> 
    (CAST(strftime('%H', datetime((SELECT timestamp FROM {_rawDataTable} WHERE timestamp < NEW.timestamp ORDER BY timestamp DESC LIMIT 1), '{tzShift} hours')) AS INT) / {interval})
BEGIN
    INSERT INTO {avgTable} (timestamp, {string.Join(", ", avgColumns)})
    SELECT 
        datetime(NEW.timestamp, '-{interval} hours'),
        {string.Join(",\n        ", avgSelects)}
    FROM (SELECT 1);

    INSERT INTO {workTimeTable} (timestamp, {string.Join(", ", workTimeColumns)})
    SELECT 
        datetime(NEW.timestamp, '-{interval} hours'),
        {string.Join(",\n        ", workTimeSelects)}
    FROM (SELECT 1);

    DELETE FROM {_rawDataTable} WHERE timestamp < datetime('now', '-{retentionDays} days');
END;";

        using var connection = new SqliteConnection(_connectionString);
        connection.Open();

        var dropCmd = connection.CreateCommand();
        dropCmd.CommandText = "DROP TRIGGER IF EXISTS trigger_shift_summary";
        dropCmd.ExecuteNonQuery();

        var createTriggerCmd = connection.CreateCommand();
        createTriggerCmd.CommandText = triggerSql;
        createTriggerCmd.ExecuteNonQuery();

        _logger.LogInformation("Триггер создан: интервал={Interval}ч, порог={Threshold}, tzShift={TzShift}, колонок={ColCount}, хранение={Retention} дней", 
            interval, threshold, tzShift, _columnCount, retentionDays);
    }

    public object GetSchema()
    {
        var columns = new List<object>();
        for (int i = 1; i <= _columnCount; i++)
        {
            columns.Add(new
            {
                id = i,
                name = $"col{i}",
                header = _headers.ElementAtOrDefault(i - 1) ?? $"Column {i}"
            });
        }

        return new
        {
            tables = _tables,
            rawDataTable = _rawDataTable,
            columnCount = _columnCount,
            columns,
            retentionDays = _retentionDays
        };
    }

    public async Task SaveData(float[] values)
    {
        using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        var columns = string.Join(", ", values.Select((_, i) => $"col{i + 1}"));
        var vars = string.Join(", ", values.Select((_, i) => $"@v{i}"));
        
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"INSERT INTO {_rawDataTable} (timestamp, {columns}) VALUES (datetime('now'), {vars})";
        
        for (int i = 0; i < values.Length; i++)
            cmd.Parameters.AddWithValue($"@v{i}", values[i]);

        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<List<object>> GetHistory(string table, int colId, string from, string to, int step = 1)
    {
        var result = new List<object>();
        using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync();

        if (!_tables.Contains(table))
        {
            _logger.LogWarning("Запрос к неизвестной таблице: {Table}", table);
            return result;
        }

        if (colId < 1 || colId > _columnCount)
        {
            _logger.LogWarning("Неверный номер колонки: {ColId} (допустимо 1-{Max})", colId, _columnCount);
            return result;
        }

        string colName = $"col{colId}";
        
        string query = $@"
            SELECT datetime(timestamp, 'localtime'), {colName} 
            FROM (
                SELECT timestamp, {colName}, ROW_NUMBER() OVER (ORDER BY timestamp) as row_num
                FROM {table}
                WHERE timestamp BETWEEN @from AND @to
            ) 
            WHERE (row_num - 1) % @step = 0";

        using var cmd = new SqliteCommand(query, connection);
        cmd.Parameters.AddWithValue("@from", from);
        cmd.Parameters.AddWithValue("@to", to);
        cmd.Parameters.AddWithValue("@step", step);

        using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            result.Add(new { 
                t = reader.GetString(0),
                v = reader.IsDBNull(1) ? null : (float?)reader.GetFloat(1) 
            });
        }
        return result;
    }

    public int ExpectedByteCount => _columnCount * sizeof(float);
    public string RawDataTable => _rawDataTable;
}
