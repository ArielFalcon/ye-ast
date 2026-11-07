import org.springframework.data.repository.Repository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.Modifying;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
@Entity class Item { @Id Long id; String code; int status; }
interface Repo extends Repository<Item,Long> {
 @Query("select i from Item i where i.code = ?1") Item findByCode(String s);
 @Modifying @Query("delete from Item i where i.status = ?1") int findByCode(int s);
}
class QueryOverload { void run(Repo r) { r.findByCode("x"); } }
