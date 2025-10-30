// verbatim implementation of heatmiser crc
#include <stdio.h>

static const unsigned char CRC16_LookupHigh[16] = {
    0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70,
    0x81, 0x91, 0xA1, 0xB1, 0xC1, 0xD1, 0xE1, 0xF1
};
static const unsigned char CRC16_LookupLow[16] = {
    0x00, 0x21, 0x42, 0x63, 0x84, 0xA5, 0xC6, 0xE7,
    0x08, 0x29, 0x4A, 0x6B, 0x8C, 0xAD, 0xCE, 0xEF
};
unsigned char CRC16_High, CRC16_Low;
void CRC16_Update4Bits(unsigned char val )
{
    unsigned char t;
    // Step one, extract the Most significant 4 bits of the CRC register
    t = CRC16_High >> 4;
    // XOR in the Message Data into the extracted bits
    t = t ^ val;
    // Shift the CRC Register left 4 bits
    CRC16_High = (CRC16_High << 4) | (CRC16_Low >> 4);
    CRC16_Low = CRC16_Low << 4;
    // Do the table lookups and XOR the result into the CRC Tables
    CRC16_High = CRC16_High ^ CRC16_LookupHigh[t];
    CRC16_Low = CRC16_Low ^ CRC16_LookupLow[t];
}
/*
* Process one Message Byte to update the current CRC Value
*/
void CRC16_Update(unsigned char val )
{
    CRC16_Update4Bits( val >> 4 ); // High nibble first
    CRC16_Update4Bits( val & 0x0f ); // Low nibble
}
void CRC16(char *buf, unsigned int len, unsigned char *low, unsigned char *hi)
{
    CRC16_High = 0xff;
    CRC16_Low = 0xff;
    //__RESET_WATCHDOG();
    while(len--)
    {
        CRC16_Update(*buf++);
    }
    *low = CRC16_Low;
    *hi = CRC16_High;
}
int main(int ac, char **av){
    static const unsigned char test[8] = {
        11, 10, 130, 0, 0, 0, 255, 255
    };
    unsigned char low;  
    unsigned char high;
    CRC16((char*)test, 8, &low, &high);
    printf("low = %x(%d) high = %x(%d) \r\n", low, low, high, high);
}
