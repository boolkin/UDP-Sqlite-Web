public static class ByteParser
{
    public static float[] ParseToFloats(byte[] buffer, string byteOrder)
    {
        int count = buffer.Length / 4;
        float[] values = new float[count];
        Span<byte> temp = stackalloc byte[4];

        for (int i = 0; i < count; i++)
        {
            int offset = i * 4;
            
            switch (byteOrder.ToUpper())
            {
                case "DCBA": // Обратный (Little-Endian swap)
                    temp[0] = buffer[offset + 3];
                    temp[1] = buffer[offset + 2];
                    temp[2] = buffer[offset + 1];
                    temp[3] = buffer[offset];
                    break;
                case "CDAB": // Перестановка слов
                    temp[0] = buffer[offset + 2];
                    temp[1] = buffer[offset + 3];
                    temp[2] = buffer[offset];
                    temp[3] = buffer[offset + 1];
                    break;
                case "BADC": // Перестановка байт
                    temp[0] = buffer[offset + 1];
                    temp[1] = buffer[offset];
                    temp[2] = buffer[offset + 3];
                    temp[3] = buffer[offset + 2];
                    break;
                default: // ABCD (Big-Endian/Прямой)
                    temp[0] = buffer[offset];
                    temp[1] = buffer[offset + 1];
                    temp[2] = buffer[offset + 2];
                    temp[3] = buffer[offset + 3];
                    break;
            }

            values[i] = BitConverter.ToSingle(temp);
        }
        
        return values;
    }
}
