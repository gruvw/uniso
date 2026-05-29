//! USB MIDI class-compliant device on RP2350 (Pico 2)
//! Sends C4 Note On every 2 seconds, Note Off after 1 second.

#![no_std]
#![no_main]

use defmt::info;
use embassy_executor::Spawner;
use embassy_rp::bind_interrupts;
use embassy_rp::usb::{Driver, InterruptHandler};
use embassy_time::Timer;
use embassy_usb::class::midi::MidiClass;
use embassy_usb::{Builder, Config};
use {defmt_rtt as _, panic_probe as _};

bind_interrupts!(struct Irqs {
    USBCTRL_IRQ => InterruptHandler<embassy_rp::peripherals::USB>;
});

// Program metadata for `picotool info`.
#[unsafe(link_section = ".bi_entries")]
#[used]
pub static PICOTOOL_ENTRIES: [embassy_rp::binary_info::EntryAddr; 4] = [
    embassy_rp::binary_info::rp_program_name!(c"USB MIDI Example"),
    embassy_rp::binary_info::rp_program_description!(
        c"Class-compliant USB MIDI device sending C4 notes"
    ),
    embassy_rp::binary_info::rp_cargo_version!(),
    embassy_rp::binary_info::rp_program_build_attribute!(),
];

// MIDI note number for C4 (middle C)
const MIDI_C4: u8 = 60;
const MIDI_CHANNEL: u8 = 0; // Channel 1 (0-indexed)
const MIDI_VELOCITY: u8 = 100;

#[embassy_executor::main]
async fn main(_spawner: Spawner) {
    let p = embassy_rp::init(Default::default());

    // Create USB driver from RP2350 USB peripheral
    let driver = Driver::new(p.USB, Irqs);

    // USB configuration
    let mut config = Config::new(0x16c0, 0x05e4); // Van Ooijen Technische Informatica / USB MIDI
    config.manufacturer = Some("Embassy");
    config.product = Some("Pico MIDI");
    config.serial_number = Some("12345678");
    config.max_power = 100; // mA

    // Allocate buffers for the USB stack
    let mut config_descriptor = [0u8; 256];
    let mut bos_descriptor = [0u8; 256];
    let mut msos_descriptor = [0u8; 256];
    let mut control_buf = [0u8; 64];

    let mut builder = Builder::new(
        driver,
        config,
        &mut config_descriptor,
        &mut bos_descriptor,
        &mut msos_descriptor,
        &mut control_buf,
    );

    // Create the MIDI class with 1 input and 1 output jack
    let mut midi = MidiClass::new(&mut builder, 1, 1, 64);

    // Build the USB device
    let mut usb = builder.build();

    // Run the USB device and MIDI sender concurrently
    let usb_fut = usb.run();

    let midi_fut = async {
        loop {
            // Wait until USB is connected and ready
            midi.wait_connection().await;
            info!("USB MIDI connected");

            loop {
                // Note On: C4, velocity 100
                let note_on = [
                    0x09,                // Cable 0, Code Index = Note On
                    0x90 | MIDI_CHANNEL, // Note On, channel 1
                    MIDI_C4,
                    MIDI_VELOCITY,
                ];
                if midi.write_packet(&note_on).await.is_err() {
                    break; // Disconnected
                }
                info!("Note On: C4");

                Timer::after_millis(1000).await;

                // Note Off: C4, velocity 0
                let note_off = [
                    0x08,                // Cable 0, Code Index = Note Off
                    0x80 | MIDI_CHANNEL, // Note Off, channel 1
                    MIDI_C4,
                    0,
                ];
                if midi.write_packet(&note_off).await.is_err() {
                    break; // Disconnected
                }
                info!("Note Off: C4");

                Timer::after_millis(1000).await;
            }

            info!("USB MIDI disconnected, waiting for reconnect...");
        }
    };

    // Run both futures concurrently — neither returns
    embassy_futures::join::join(usb_fut, midi_fut).await;
}
