package shop;
import shop.mapper.AccountMapper;
class Accounts {
 private AccountMapper accounts;
 void run() {
  accounts.find("a");
  accounts.add(null);
  accounts.rename("n");
  accounts.clear();
  accounts.owners();
  accounts.dynamic("t");
  accounts.both();
  accounts.locked();
 }
}
