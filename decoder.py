def get_factory_admin_password(mac):
    salt = "CTRLABLE_KEY_2026"
    combined = mac + salt

    hash_num = 0
    for i, ch in enumerate(combined):
        hash_num += ord(ch) * (i + 1)

    return "CN" + str(hash_num)[:5]


if __name__ == "__main__":
    mac = input("Podaj adres MAC (np. AA:BB:CC:DD:EE:FF): ").strip()
    password = get_factory_admin_password(mac)

    print(f"\nHasło admin: {password}")