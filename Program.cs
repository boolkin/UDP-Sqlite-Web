using System.Globalization;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<DatabaseService>();
builder.Services.AddHostedService<UdpListenerService>();

// CORS
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader();
    });
});

var app = builder.Build();

app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles();

var logger = app.Services.GetRequiredService<ILogger<Program>>();

// Схема базы данных
app.MapGet("/api/schema", (DatabaseService db) =>
{
    logger.LogInformation("Schema request");
    return Results.Ok(db.GetSchema());
});

async Task<IResult> GetData(DatabaseService db, string table, int colId, string from, string to, int step)
{
    logger.LogInformation("API Request: table={Table}, colId={ColId}, from={From}, to={To}, step={Step}", 
        table, colId, from, to, step);

    if (!DateTime.TryParse(from, CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime fromLocal) || 
        !DateTime.TryParse(to, CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime toLocal))
    {
        logger.LogWarning("Неверный формат даты/времени: from={From}, to={To}", from, to);
        return Results.BadRequest("Invalid date format. Use format: yyyy-MM-dd HH:mm:ss");
    }

    DateTime fromUtc = fromLocal.ToUniversalTime();
    DateTime toUtc = toLocal.ToUniversalTime();

    string sqlFrom = fromUtc.ToString("yyyy-MM-dd HH:mm:ss");
    string sqlTo = toUtc.ToString("yyyy-MM-dd HH:mm:ss");

    logger.LogDebug("Time conversion: Local {FromLocal:HH:mm:ss} -> UTC {FromUtc}", fromLocal, sqlFrom);

    try 
    {
        var data = await db.GetHistory(table, colId, sqlFrom, sqlTo, step);
        int count = (data as System.Collections.IList)?.Count ?? 0;
        logger.LogInformation("Query returned {Count} rows", count);
        return Results.Ok(data);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Database query failed");
        return Results.Problem(ex.Message);
    }
}

// История из таблицы сырых данных (первая в конфиге)
app.MapGet("/api/history", async (DatabaseService db, int id, string from, string to, int step = 1) => 
    await GetData(db, db.RawDataTable, id, from, to, step));

// Произвольная таблица из конфига
app.MapGet("/api/statistics", async (DatabaseService db, string table, int id, string from, string to) => 
    await GetData(db, table, id, from, to, 1));

app.Run();
