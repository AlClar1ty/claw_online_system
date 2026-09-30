#!/usr/bin/env python3
"""Tahan satu pin GPIO Raspberry Pi. Perintah dari stdin: 1, 0, atau quit."""

import sys

import RPi.GPIO as GPIO


def main():
    pin = int(sys.argv[1])
    active_high = sys.argv[2] == "1"
    level_on = GPIO.HIGH if active_high else GPIO.LOW
    level_off = GPIO.LOW if active_high else GPIO.HIGH

    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    GPIO.setup(pin, GPIO.OUT, initial=level_off)
    print("ready", flush=True)

    try:
        for line in sys.stdin:
            command = line.strip()
            if command == "1":
                GPIO.output(pin, level_on)
            elif command == "0":
                GPIO.output(pin, level_off)
            elif command == "quit":
                break
            else:
                print("bad", flush=True)
                continue
            print("ok", flush=True)
    finally:
        GPIO.output(pin, level_off)
        GPIO.cleanup(pin)


if __name__ == "__main__":
    main()
