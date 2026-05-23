public class UdpSettings
{
    public int Port { get; set; }
    public string DataType { get; set; } = "float";
    public string ByteOrder { get; set; } = "ABCD";
    public bool EnableInfoLogging { get; set; }
}

public class DatabaseSettings
{
    public string FileName { get; set; } = "data2.db";
    public List<string> Tables { get; set; } = new();
    public int ColumnCount { get; set; } = 10;
    public List<string> Headers { get; set; } = new();
    public int RetentionDays { get; set; } = 3;
}

public class TriggerSettings
{
    public bool Enabled { get; set; } = true;
    public int IntervalHours { get; set; } = 12;
    public double Threshold { get; set; } = 0.9;
    public int TimezoneShift { get; set; } = -5;
}
