"""Temperature conversions."""


def c_to_f(celsius: float) -> float:
    """Convert Celsius to Fahrenheit."""
    # BUG: forgot the + 32 offset, so 0C wrongly yields 0F instead of 32F.
    return celsius * 9 / 5


def f_to_c(fahrenheit: float) -> float:
    """Convert Fahrenheit to Celsius."""
    return (fahrenheit - 32) * 5 / 9
