package shop;
import shop.mapper.UserMapper;
import shop.scanned.Scanned;
import shop.elsewhere.Elsewhere;
class Use {
 private UserMapper users;
 private Scanned scanned;
 private Elsewhere elsewhere;
 void run(String id) {
  users.insert(null);
  users.findById(id);
  users.touch(id);
  users.ghost(id);
  users.twice(id);
  users.renamed(id);
  users.helper();
  scanned.list();
  elsewhere.list();
 }
}
