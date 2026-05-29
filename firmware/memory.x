/* memory.x for RP2350 */
MEMORY
{
    /* Standard flash and RAM boundaries for the RP2350 */
    FLASH : ORIGIN = 0x10000000, LENGTH = 4096K
    RAM   : ORIGIN = 0x20000000, LENGTH = 512K
}

SECTIONS {
    /* ### Boot ROM info
     * This MUST reside within the first 4K of flash right after the vector table
     * so the RP2350 BootROM can locate the executable's signature. */
    .start_block : ALIGN(4) {
        __start_block_addr = .;
        KEEP(*(.start_block));
        KEEP(*(.boot_info));
    } > FLASH
} INSERT AFTER .vector_table;

/* Reposition the start of the program instructions to sit right after the boot block */
_stext = ADDR(.start_block) + SIZEOF(.start_block);

SECTIONS {
    /* ### Boot ROM extra info
     * This sits at the absolute end of the compiled binary image. */
    .end_block : ALIGN(4) {
        __end_block_addr = .;
        KEEP(*(.end_block));
        __flash_binary_end = .;
    } > FLASH
} INSERT AFTER .uninit;

PROVIDE(start_to_end = __end_block_addr - __start_block_addr);
PROVIDE(end_to_start = __start_block_addr - __end_block_addr);
