import argparse


def main():
    parser = argparse.ArgumentParser(
        description="Print a greeting message.",
    )
    parser.add_argument(
        "--name",
        default="jeff",
        help="name to include in the greeting (default: %(default)s)",
    )
    args = parser.parse_args()
    print(f"hi, test of claude from {args.name}")

if __name__ == "__main__":
    main()
