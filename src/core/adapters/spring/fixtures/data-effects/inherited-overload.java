import org.springframework.data.jpa.repository.JpaRepository;

class Item {}

interface Repo extends JpaRepository<Item, Long> {
  @org.springframework.data.jpa.repository.Modifying
  @org.springframework.data.jpa.repository.Query("delete from Item where id=?1")
  int findById(int id);
}

class Svc {
  void run(Repo r) { r.findById(1L); }
}
