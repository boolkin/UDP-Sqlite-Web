using System.Net.Sockets;

public class UdpListenerService : BackgroundService
{
    private readonly ILogger<UdpListenerService> _logger;
    private readonly UdpSettings _settings;
    private readonly DatabaseService _dbService;

    public UdpListenerService(
        ILogger<UdpListenerService> logger, 
        IConfiguration config, 
        DatabaseService dbService)
    {
        _logger = logger;
        _dbService = dbService;
        _settings = config.GetSection("UdpSettings").Get<UdpSettings>() ?? new();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var udpClient = new UdpClient(_settings.Port);
        _logger.LogInformation("UDP слушатель запущен на порту {Port}", _settings.Port);
        _logger.LogInformation("Ожидаемый размер пакета: {Bytes} байт ({Count} float)", 
            _dbService.ExpectedByteCount, _dbService.ExpectedByteCount / 4);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var result = await udpClient.ReceiveAsync(stoppingToken);
                
                // Валидация размера пакета
                if (result.Buffer.Length != _dbService.ExpectedByteCount)
                {
                    _logger.LogWarning("Пакет неверного размера: {Actual} байт (ожидалось {Expected}). Пропущен.", 
                        result.Buffer.Length, _dbService.ExpectedByteCount);
                    continue;
                }
                
                float[] values = ByteParser.ParseToFloats(result.Buffer, _settings.ByteOrder);
                await _dbService.SaveData(values);

                if (_settings.EnableInfoLogging)
                {
                    _logger.LogInformation("Записано {Count} значений: {Values}", 
                        values.Length, string.Join(", ", values.Select(v => v.ToString("F2"))));
                }
            }
            catch (OperationCanceledException)
            {
                _logger.LogInformation("UDP слушатель останавливается...");
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Ошибка при обработке UDP пакета");
            }
        }
        
        _logger.LogInformation("UDP слушатель остановлен");
    }
}
